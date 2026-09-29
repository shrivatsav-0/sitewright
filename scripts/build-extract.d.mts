/**
 * Types for the in-page extractor build script.
 *
 * The script is a `.mjs` file so it can be run directly with node and so the
 * drift test can import its one exported function. This declaration gives that
 * import a type instead of degrading to `any`, which would hide a signature
 * change until runtime.
 */
export declare function buildExtractScript(): string;
