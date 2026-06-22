import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPublicSalesIntakeRoutes } from '../src/routes/public-sales-intake.routes';
import { verifyCortexHmac } from '../src/services/intake.service';
import * as salesIntake from '../src/services/public-sales-intake.service';

vi.mock('../src/services/intake.service', () => ({
  verifyCortexHmac: vi.fn(),
}));

vi.mock('../src/services/public-sales-intake.service', () => ({
  submitCatalogAuditSalesIntake: vi.fn(),
}));

const payload = {
  tag: 'website_catalog_audit',
  page_url: 'https://uniecortex.com/audit',
  contact: {
    contactName: 'Catalog Lead',
    email: 'catalog@example.com',
    company: 'Catalog Co',
  },
  fields: {
    website: 'https://example.com',
    confidence: 72,
    product_count: 18,
  },
  meta: {
    cortex_reference: 'CAT-TEST-1',
  },
};

async function buildApp() {
  const app = Fastify();
  await registerPublicSalesIntakeRoutes(app);
  await app.ready();
  return app;
}

describe('public catalog-audit sales intake routes', () => {
  beforeEach(() => {
    vi.mocked(verifyCortexHmac).mockReset();
    vi.mocked(salesIntake.submitCatalogAuditSalesIntake).mockReset();
  });

  it.each([
    '/api/public/sales-intake/unieconnect-catalog-audit',
    '/public/sales-intake/unieconnect-catalog-audit',
  ])('accepts a signed catalog audit on %s', async (url) => {
    vi.mocked(verifyCortexHmac).mockReturnValue(true);
    vi.mocked(salesIntake.submitCatalogAuditSalesIntake).mockResolvedValue({
      lead_id: 'lead-123',
      status: 'created',
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-uniesales-signature': 'sha256=valid',
      },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ lead_id: 'lead-123', status: 'created' });
    expect(salesIntake.submitCatalogAuditSalesIntake).toHaveBeenCalledWith(payload);
    await app.close();
  });

  it('rejects an invalid signature before creating sales activity', async () => {
    vi.mocked(verifyCortexHmac).mockReturnValue(false);
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/sales-intake/unieconnect-catalog-audit',
      headers: {
        'content-type': 'application/json',
        'x-uniesales-signature': 'sha256=bad',
      },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
    expect(salesIntake.submitCatalogAuditSalesIntake).not.toHaveBeenCalled();
    await app.close();
  });
});
