// Client-side parser and serializer for queries data.
// We use a server-side endpoint /api/queries that returns parsed JSON, so the
// client only needs to know the shape. This file holds the empty defaults.

export function defaults() {
  return {
    queries: [],
    manual_additions: [],
  };
}

export function emptyManualAddition() {
  return {
    title: '',
    authors: '',
    year: '',
    venue: '',
    doi: '',
    url: '',
    pdf_url: '',
    reason: '',
  };
}
