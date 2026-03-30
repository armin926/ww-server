declare module 'mammoth' {
  interface ExtractResult {
    value: string;
    messages: Array<{
      type: string;
      message: string;
    }>;
  }

  interface ExtractOptions {
    buffer?: Buffer;
    path?: string;
  }

  function extractRawText(options: ExtractOptions): Promise<ExtractResult>;

  export { extractRawText, ExtractResult, ExtractOptions };
}
