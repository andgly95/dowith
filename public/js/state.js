// The S bag — all shared mutable client state.
export const S = {
  wire: null,      // last /api/state
  spaceId: null,   // which list is open
  items: [],       // that list's items, as the server rendered them
  space: null,
  compose: 'shared',   // the visibility the composer will use next
};
