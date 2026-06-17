import { buildServiceMetadata, ServiceLanding } from '@/components/ServiceLanding';

export const metadata = buildServiceMetadata('moto');

export default function MotoPage() {
  return <ServiceLanding slug="moto" />;
}
