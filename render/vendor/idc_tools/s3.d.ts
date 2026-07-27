export declare const idcS3: (bucket?: string) => string;
/** fetch with retries + jittered exponential backoff (the IDC S3 endpoint returns transient errors under concurrency). */
export declare function fetchRetry(url: string, opts?: RequestInit, tries?: number): Promise<Response>;
/** List every `.dcm` object key under a series prefix via S3 ListObjectsV2 (paged). */
export declare function s3ListKeys(prefix: string, bucket?: string): Promise<string[]>;
/** Build an OHIF viewer deep-link for a study (for "open in IDC viewer" links). */
export declare function ohifViewerURL(studyInstanceUID?: string): string | null;
