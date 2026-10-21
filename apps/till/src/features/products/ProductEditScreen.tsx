import {
  createProduct,
  getProduct,
  listGenericNames,
  listManufacturerNames,
  listTaxClasses,
  updateProduct,
  type ProductDetail,
  type ProductInput,
} from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useRoute } from '../../app/router';
import { useAction, useServices } from '../../app/services';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { productTitle } from '../../lib/format';
import { S } from '../../strings';
import { Button, EmptyState, Field, Loading, Notice, PageHeader, TextInput } from '../../ui';
import {
  emptyProductForm,
  errorsByRow,
  productFormFromDetail,
  productFormToInput,
  type FormConversion,
} from './form-state';
import { ProductForm, type ProductFormLists } from './ProductForm';

/** New product when `productId` is missing, otherwise edit. */
export function ProductEditScreen({ productId }: { productId?: string }) {
  const { ctx } = useServices();
  const product = useQuery({
    queryKey: ['product', productId],
    queryFn: () => getProduct(ctx, productId!),
    enabled: !!productId,
  });
  const lists = useQuery({
    queryKey: ['product-form-lists'],
    queryFn: async (): Promise<ProductFormLists> => ({
      manufacturers: await listManufacturerNames(ctx),
      generics: await listGenericNames(ctx),
      taxClasses: await listTaxClasses(ctx),
    }),
  });

  if (!lists.data || (productId && product.isPending)) return <Loading />;
  if (productId && !product.data) return <EmptyState>{S.product.notFound}</EmptyState>;
  return <Editor existing={product.data ?? null} lists={lists.data} />;
}

function Editor({ existing, lists }: { existing: ProductDetail | null; lists: ProductFormLists }) {
  const { navigate, back } = useRoute();
  const [state, setState] = useState(() =>
    existing ? productFormFromDetail(existing) : emptyProductForm(),
  );
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [conversion, setConversion] = useState<FormConversion | null>(null);
  const [reason, setReason] = useState('');

  const save = useAction(
    (ctx, input: ProductInput) =>
      existing
        ? updateProduct(ctx, existing.id, input, { reason: reason.trim() || undefined })
        : createProduct(ctx, input),
    {
      onSuccess: (saved) => navigate({ name: 'product', id: saved.id }, { replace: !existing }),
    },
  );

  const draft = productFormToInput(state);
  const priceChanged =
    existing !== null &&
    (draft.input.salePrice !== existing.salePrice ||
      draft.input.priceQty !== existing.priceQty ||
      (draft.input.costPrice ?? null) !== existing.costPrice);

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = productFormToInput(state);
    setConversion(result);
    setLocalErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    save.mutate(result.input);
  }

  const serverErrors = conversion ? errorsByRow(fieldErrors(save.error), conversion) : {};
  const localByRow = conversion ? errorsByRow(localErrors, conversion) : {};
  const errors = { ...serverErrors, ...localByRow };
  const hasErrors = Object.keys(errors).length > 0 || save.isError;

  return (
    <form className="page" onSubmit={submit} noValidate>
      <PageHeader
        title={existing ? `${S.product.editTitle}: ${productTitle(existing)}` : S.product.newTitle}
        onBack={back}
      />
      {hasErrors && (
        <Notice tone="bad">
          {save.isError ? errorMessage(save.error) : Object.values(errors)[0]}
        </Notice>
      )}
      <ProductForm state={state} setState={setState} errors={errors} lists={lists} />
      {priceChanged && (
        <div className="form-reason">
          <Field label={S.product.priceChangeReason} hint={S.product.priceChangeReasonHint}>
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {S.common.save}
        </Button>
        <Button onClick={back}>{S.common.cancel}</Button>
      </div>
    </form>
  );
}
