import { buildServiceMetadata, ServiceLanding } from '@/components/ServiceLanding';

export const metadata = buildServiceMetadata('auto');

export default function AutoPage() {
  return <ServiceLanding slug="auto" />;
}
