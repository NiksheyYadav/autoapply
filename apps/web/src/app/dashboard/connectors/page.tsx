import { UnderConstruction } from '@/components/UnderConstruction';

export default function ConnectorsPage() {
  return (
    <UnderConstruction
      standalone={false}
      title="Connectors are being surveyed"
      message="Linking Greenhouse, Lever, and Ashby accounts is on the way — the backend already exists, the dashboard for it doesn't, yet."
      backHref="/dashboard"
      backLabel="Back to overview"
    />
  );
}
