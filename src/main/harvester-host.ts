import { join } from 'node:path';
import { utilityProcess, type UtilityProcess, type BrowserWindow } from 'electron';
import { CH } from '@shared/ipc';
import type { HarvestProgress } from '@shared/types';

/**
 * Owns the harvester utilityProcess.
 *
 * The harvester never runs in the renderer and never blocks main: it is a separate OS
 * process with its own SQLite connection, and it reports back over the utilityProcess
 * message channel, which main forwards to the UI.
 */

export interface HarvestStartMessage {
  type: 'start';
  dbPath: string;
  sourceIds: number[];
}

export interface HarvestCancelMessage {
  type: 'cancel';
}

export type ToHarvester = HarvestStartMessage | HarvestCancelMessage;

export type FromHarvester =
  | { type: 'progress'; payload: HarvestProgress }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; scope: string; message: string }
  | { type: 'finished' };

let child: UtilityProcess | null = null;

function harvesterEntry(): string {
  // electron-vite emits the harvester bundle alongside the main bundle.
  return join(import.meta.dirname, 'harvester.js');
}

export function startHarvest(win: BrowserWindow, dbPath: string, sourceIds: number[]): { ok: boolean; error?: string } {
  if (child) return { ok: false, error: 'A harvest is already running' };
  if (sourceIds.length === 0) return { ok: false, error: 'No sources selected' };

  const proc = utilityProcess.fork(harvesterEntry(), [], {
    serviceName: 'gis-browser-harvester',
    stdio: 'inherit',
  });
  child = proc;

  proc.on('message', (msg: FromHarvester) => {
    if (win.isDestroyed()) return;
    if (msg.type === 'progress') {
      win.webContents.send(CH.harvestProgress, msg.payload);
    } else if (msg.type === 'log') {
      win.webContents.send(CH.log, {
        level: msg.level,
        scope: msg.scope,
        message: msg.message,
        at: new Date().toISOString(),
      });
    }
  });

  proc.on('exit', (code) => {
    child = null;
    if (win.isDestroyed()) return;
    win.webContents.send(CH.log, {
      level: code === 0 ? 'info' : 'error',
      scope: 'harvester',
      message: `harvester exited with code ${code}`,
      at: new Date().toISOString(),
    });
  });

  const start: HarvestStartMessage = { type: 'start', dbPath, sourceIds };
  proc.postMessage(start);
  return { ok: true };
}

export function cancelHarvest(): void {
  if (!child) return;
  const cancel: HarvestCancelMessage = { type: 'cancel' };
  child.postMessage(cancel);
}

export function killHarvest(): void {
  child?.kill();
  child = null;
}
