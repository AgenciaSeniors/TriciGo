import { buildServiceMetadata, ServiceLanding } from '@/components/ServiceLanding';

export const metadata = buildServiceMetadata('mensajeria');

export default function MensajeriaPage() {
  return <ServiceLanding slug="mensajeria" />;
}
