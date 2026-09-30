/** A pointer into the kernel, provider- and vendor-neutral. */
export type KernelRefLike = { readonly kind: string; readonly id: string; readonly pin?: string | null };
