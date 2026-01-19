import { LlmProvider } from '../llm.provider';

export class MockLlmProvider implements LlmProvider {
  async suggest({ model }: { model: any }) {
    const hasInvoice = (model.entities ?? []).some(
      (e: any) => e.name === 'Invoice',
    );
    const patch: any[] = [];

    // Clase nueva
    if (!hasInvoice) {
      patch.push({
        op: 'add',
        path: '/entities/-',
        value: {
          name: 'Invoice',
          attrs: [
            { name: 'id', type: 'uuid', pk: true },
            { name: 'total', type: 'decimal(12,2)' },
          ],
        },
      });
    }

    // Relación con Customer
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: {
        from: 'Invoice',
        to: 'Customer',
        kind: 'association',
        fromCard: 'N',
        toCard: '1',
      },
    });

    // Mejorar tipo de datos (ej.: User.id string → uuid)
    patch.push({
      op: 'replace',
      path: '/entities[name=User]/attrs[name=id]/type',
      value: 'uuid',
    });

    const rationale =
      'Se agrega Invoice y relación con Customer para facturación; se normaliza id de User a uuid.';
    return { rationale, patch };
  }
}
