/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, IExtensionHostConfiguration } from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import { IRunData } from './nodeLauncherBase';
import { SubprocessProgram, TerminalProcess } from './program';
import { spawnWatchdog } from './watchdogSpawn';
import Cdp from '../../cdp/api';
import { NodeAttacherBase } from './nodeAttacherBase';
import { injectable } from 'inversify';
import { retryGetWSEndpoint } from '../browser/spawn/endpoints';
import { LogTag } from '../../common/logging';

/**
 * Attaches to an instance of VS Code for extension debugging.
 */
@injectable()
export class ExtensionHostAttacher extends NodeAttacherBase<IExtensionHostConfiguration> {
  protected restarting = false;

  /**
   * @inheritdoc
   */
  public async restart() {
    this.restarting = true;
    this.onProgramTerminated({ code: 0, killed: true, restart: true });
    this.program?.stop();
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): IExtensionHostConfiguration | undefined {
    return params.type === DebugType.ExtensionHost && params.request === 'attach'
      ? params
      : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async launchProgram(
    runData: IRunData<IExtensionHostConfiguration>,
  ): Promise<string | void> {
    const inspectorURL = await retryGetWSEndpoint(
      `http://localhost:${runData.params.port}`,
      runData.context.cancellationToken,
    );

    const binary = await this.resolveNodePath(runData.params);
    const wd = spawnWatchdog(binary.path, {
      ipcAddress: runData.serverAddress,
      scriptName: 'Extension Host',
      inspectorURL,
      waitForDebugger: true,
      dynamicAttach: true,
    });

    const program = (this.program = new SubprocessProgram(wd, this.logger));
    this.program.stopped.then(result => {
      if (program === this.program) {
        this.onProgramTerminated(result);
      }
    });
  }

  /**
   * @override
   */
  protected createLifecycle(
    cdp: Cdp.Api,
    run: IRunData<IExtensionHostConfiguration>,
    target: Cdp.Target.TargetInfo,
  ) {
    return target.openerId ? {} : { initialized: () => this.onFirstInitialize(cdp, run) };
  }

  /**
   * Called the first time, for each program, we get an attachment. Can
   * return disposables to clean up when the run finishes.
   */
  protected async onFirstInitialize(cdp: Cdp.Api, run: IRunData<IExtensionHostConfiguration>) {
    this.setEnvironmentVariables(cdp, run);
    const telemetry = await this.gatherTelemetry(cdp, run);

    // Monitor the process ID we read from the telemetry. Once the VS Code
    // process stops, stop our Watchdog, and vise versa.
    const watchdog = this.program;
    if (telemetry && watchdog) {
      const code = new TerminalProcess({ processId: telemetry.processId }, this.logger);
      code.stopped.then(() => watchdog.stop());
      watchdog.stopped.then(() => {
        if (!this.restarting) {
          code.stop();
        }
      });
    }
  }

  private async setEnvironmentVariables(cdp: Cdp.Api, run: IRunData<IExtensionHostConfiguration>) {
    if (!run.params.autoAttachChildProcesses) {
      return;
    }

    // We know VS Code uses Node 12 (right now) so spaces are gucci
    const vars = (await this.resolveEnvironment(run, true)).merge({
      NODE_INSPECTOR_PPID: '0',
    });

    const result = await cdp.Runtime.evaluate({
      contextId: 1,
      returnByValue: true,
      expression: `Object.assign(process.env, ${JSON.stringify(vars.defined())})`,
    });

    if (!result) {
      this.logger.error(LogTag.RuntimeTarget, 'Undefined result setting child environment vars');
    } else if (result.exceptionDetails) {
      this.logger.error(
        LogTag.RuntimeTarget,
        'Error setting child environment vars',
        result.exceptionDetails,
      );
    }
  }
}
