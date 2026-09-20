/**
 * Job-board providers this platform can pull postings from, per docs/06 § job
 * sources (`greenhouse`, `lever`, `ashby` — `manual`/`seed`/`rss` in
 * `JOB_SOURCES` aren't third-party accounts, so they're not connectors).
 * Each is board-token based, not OAuth, which is what actually lets this be
 * buildable without a registered OAuth app for a provider nothing here has
 * real credentials for.
 */
export const CONNECTOR_PROVIDERS = ['greenhouse', 'lever', 'ashby'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export function isConnectorProvider(value: string): value is ConnectorProvider {
  return (CONNECTOR_PROVIDERS as readonly string[]).includes(value);
}
