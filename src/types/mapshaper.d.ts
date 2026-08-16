/**
 * mapshaper 0.7 ships no type declarations. Only the two entry points we actually use are
 * declared, deliberately: a fuller guess at its surface would be a fiction the compiler
 * would then enforce.
 *
 * applyCommands runs a command string against in-memory files and hands back in-memory
 * files, so nothing touches disk and no system binary is involved — which is what keeps
 * the app to the brief's one-installer, pure-JS constraint.
 */
declare module 'mapshaper' {
  export function applyCommands(
    commands: string,
    input: Record<string, string | Uint8Array>,
    callback: (err: Error | null, output: Record<string, unknown>) => void,
  ): void;

  export function runCommands(commands: string, callback: (err: Error | null) => void): void;

  export function enableLogging(): void;
}
