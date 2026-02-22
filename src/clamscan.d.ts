declare module 'clamscan' {
  interface ClamScanConfig {
    clamdscan?: {
      host?: string;
      port?: number;
      timeout?: number;
      localFallback?: boolean;
      active?: boolean;
    };
    preference?: string;
  }

  interface ScanStreamResult {
    isInfected: boolean;
    viruses: string[];
  }

  class NodeClam {
    init(config: ClamScanConfig): Promise<NodeClam>;
    scanStream(stream: NodeJS.ReadableStream): Promise<ScanStreamResult>;
  }

  export = NodeClam;
}
