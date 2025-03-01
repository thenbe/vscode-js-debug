/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import { IPortLeaseTracker } from '../../adapter/portLeaseTracker';
import { getSourceSuffix } from '../../adapter/templates';
import Cdp from '../../cdp/api';
import { CancellationTokenSource } from '../../common/cancellation';
import { DebugType } from '../../common/contributionUtils';
import { ILogger, LogTag } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
import { isLoopback } from '../../common/urlUtils';
import { AnyLaunchConfiguration, INodeAttachConfiguration } from '../../configuration';
import { retryGetNodeEndpoint } from '../browser/spawn/endpoints';
import { ISourcePathResolverFactory } from '../sourcePathResolverFactory';
import { IStopMetadata } from '../targets';
import { LeaseFile } from './lease-file';
import { NodeAttacherBase } from './nodeAttacherBase';
import { watchAllChildren } from './nodeAttacherCluster';
import { INodeBinaryProvider, NodeBinary } from './nodeBinaryProvider';
import { IRunData } from './nodeLauncherBase';
import { IProgram, StubProgram, WatchDogProgram } from './program';
import { IRestartPolicy, RestartPolicyFactory } from './restartPolicy';
import { WatchDog } from './watchdogSpawn';

/**
 * Attaches to ongoing Node processes. This works pretty similar to the
 * existing Node launcher, except with how we attach to the entry point:
 * we don't have the bootloader in there, so we manually attach and enable
 * the debugger, then evaluate and set the environment variables so that
 * child processes operate just like those we boot with the NodeLauncher.
 */
@injectable()
export class NodeAttacher extends NodeAttacherBase<INodeAttachConfiguration> {
  constructor(
    @inject(INodeBinaryProvider) pathProvider: INodeBinaryProvider,
    @inject(ILogger) logger: ILogger,
    @inject(ISourcePathResolverFactory) pathResolverFactory: ISourcePathResolverFactory,
    @inject(IPortLeaseTracker) portLeaseTracker: IPortLeaseTracker,
    private readonly restarters = new RestartPolicyFactory(),
  ) {
    super(pathProvider, logger, portLeaseTracker, pathResolverFactory);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): INodeAttachConfiguration | undefined {
    return params.type === DebugType.Node && params.request === 'attach' ? params : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async launchProgram(runData: IRunData<INodeAttachConfiguration>): Promise<void> {
    const doLaunch = async (
      restartPolicy: IRestartPolicy,
      restarting?: IProgram,
    ): Promise<void> => {
      const prevProgram = this.program;

      let inspectorURL: string;
      try {
        if (runData.params.websocketAddress) {
          inspectorURL = runData.params.websocketAddress;
        } else {
          inspectorURL = await retryGetNodeEndpoint(
            `http://${runData.params.address}:${runData.params.port}`,
            restarting && runData.params.timeout > 0
              ? CancellationTokenSource.withTimeout(runData.params.timeout).token
              : runData.context.cancellationToken,
            this.logger,
          );
        }
      } catch (e) {
        if (prevProgram && prevProgram === restarting /* is a restart */) {
          return restart(restartPolicy, prevProgram, { killed: false, code: 1 });
        } else {
          throw e;
        }
      }

      const watchdog = await WatchDog.attach({
        ipcAddress: runData.serverAddress,
        scriptName: 'Remote Process',
        inspectorURL,
        remoteHostHeader: runData.params.remoteHostHeader,
        waitForDebugger: true,
        dynamicAttach: true,
      });

      const program = (this.program = new WatchDogProgram(watchdog));
      program.stopped.then(r => restart(restartPolicy.reset(), program, r));
    };

    const restart = async (
      restartPolicy: IRestartPolicy,
      program: IProgram,
      result: IStopMetadata,
    ) => {
      if (this.program !== program) {
        return;
      }

      if (result.killed) {
        this.onProgramTerminated(result);
        return;
      }

      const nextRestart = restartPolicy.next();
      if (!nextRestart) {
        this.onProgramTerminated(result);
        return;
      }

      runData.context.dap.output({
        output: l10n.t('Lost connection to debugee, reconnecting in {0}ms\r\n', nextRestart.delay),
      });

      const deferred = new StubProgram();
      this.program = deferred;

      const killed = await Promise.race([delay(nextRestart.delay), deferred.stopped]);
      if (this.program !== deferred) {
        return;
      }

      if (killed) {
        this.onProgramTerminated(result);
      } else {
        doLaunch(nextRestart, deferred);
      }
    };

    return doLaunch(this.restarters.create(runData.params.restart));
  }

  /**
   * @override
   */
  protected createLifecycle(
    cdp: Cdp.Api,
    run: IRunData<INodeAttachConfiguration>,
    target: Cdp.Target.TargetInfo,
  ) {
    if (target.openerId) {
      return {};
    }

    let leaseFile: Promise<LeaseFile>;
    return {
      initialized: async () => {
        leaseFile = this.onFirstInitialize(cdp, run, target);
        await leaseFile;
      },
      close: () => {
        // A close while we're still attach indicates a graceful shutdown.
        if (this.targetList().length) {
          this.program?.stop();
        }

        leaseFile?.then(l => l.dispose());
      },
    };
  }

  protected async onFirstInitialize(
    cdp: Cdp.Api,
    run: IRunData<INodeAttachConfiguration>,
    parentInfo: Cdp.Target.TargetInfo,
  ) {
    // We use a lease file to indicate to the process that the debugger is
    // still running. This is needed because once we attach, we set the
    // NODE_OPTIONS for the process, forever. We can try to unset this on
    // close, but this isn't reliable as it's always possible
    const leaseFile = new LeaseFile();
    await leaseFile.startTouchLoop();

    const binary = await this.resolveNodePath(run.params);
    const [telemetry] = await Promise.all([
      this.gatherTelemetryFromCdp(cdp, run),
      this.setEnvironmentVariables(cdp, run, leaseFile.path, parentInfo.targetId, binary),
    ]);

    if (telemetry && run.params.attachExistingChildren) {
      watchAllChildren(
        {
          pid: telemetry.processId,
          nodePath: binary.path,
          hostname: run.params.address,
          ipcAddress: run.serverAddress,
        },
        parentInfo.targetId,
        this.logger,
      ).catch(err => this.logger.warn(LogTag.Internal, 'Error watching child processes', { err }));
    }

    return leaseFile;
  }

  private async setEnvironmentVariables(
    cdp: Cdp.Api,
    run: IRunData<INodeAttachConfiguration>,
    leasePath: string,
    openerId: string,
    binary: NodeBinary,
  ) {
    if (!run.params.autoAttachChildProcesses) {
      return;
    }

    if (!(await isLoopback(run.params.address))) {
      this.logger.warn(LogTag.RuntimeTarget, 'Cannot attach to children of remote process');
      return;
    }

    const vars = await this.resolveEnvironment(run, binary, { requireLease: leasePath, openerId });
    for (let retries = 0; retries < 5; retries++) {
      const result = await cdp.Runtime.evaluate({
        contextId: 1,
        returnByValue: true,
        expression:
          `typeof process === 'undefined' || process.pid === undefined ? 'process not defined' : Object.assign(process.env, ${JSON.stringify(
            vars.defined(),
          )})` + getSourceSuffix(),
      });

      if (!result) {
        this.logger.error(LogTag.RuntimeTarget, 'Undefined result setting child environment vars');
        return;
      }

      if (!result.exceptionDetails && result.result.value !== 'process not defined') {
        return;
      }

      this.logger.error(LogTag.RuntimeTarget, 'Error setting child environment vars', result);
      await delay(50);
    }
  }
}
