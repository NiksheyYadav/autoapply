import { UnderConstruction } from '@/components/UnderConstruction';

export default function NotFound() {
  return (
    <UnderConstruction
      title="This route isn't on the map"
      message="Whatever you were looking for, it isn't here. Let's get you back on a route that's actually plotted."
      backHref="/"
      backLabel="Back to Atlas"
    />
  );
}
