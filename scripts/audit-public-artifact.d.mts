export function inspectPublicText(text: string, path: string): void;
export function auditPublicArtifact(directory: string, options?: { complete?: boolean }): Promise<{ path: string; sha256: string; bytes: number }[]>;
