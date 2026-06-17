import { buildServiceMetadata, ServiceLanding } from '@/components/ServiceLanding';

export const metadata = buildServiceMetadata('triciclo');

export default function TricicloPage() {
  return <ServiceLanding slug="triciclo" />;
}
