// Ambient declarations for the Node globals the CLI reaches for.
// Kept narrow on purpose — @types/node would bring the kitchen sink.
// If you need more surface, add it here explicitly rather than pulling
// the whole types package.

declare const process: {
  readonly argv: readonly string[]
  readonly cwd: () => string
  readonly stdout: { write(chunk: string): boolean }
  readonly stderr: { write(chunk: string): boolean }
  exit(code?: number): never
}

declare module "node:path" {
  export function resolve(...segments: string[]): string
}

declare module "node:fs/promises" {
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL
}

declare module "node:path" {
  export function join(...segments: string[]): string
}

declare module "node:os" {
  export function tmpdir(): string
}

declare const Buffer: {
  from(data: Uint8Array | string, encoding?: string): { toString(encoding?: string): string }
}
