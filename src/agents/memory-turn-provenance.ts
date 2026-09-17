/** Host-private, sticky memory provenance for one turn across retry attempts. */
export type MemoryTurnProvenance = {
  isTainted(): boolean;
  markTainted(): void;
};

export function createMemoryTurnProvenance(initiallyTainted = false): MemoryTurnProvenance {
  let tainted = initiallyTainted;
  return {
    isTainted: () => tainted,
    markTainted: () => {
      tainted = true;
    },
  };
}
