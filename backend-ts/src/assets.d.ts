/** Files the backend carries as text: the schema is imported, so `bun build --compile` bundles it. */
declare module '*.sql' { const text: string; export default text }
