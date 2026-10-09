import { FormattedMessage } from 'react-intl'
import React from 'react'
import styled from 'styled-components'

import { InlineLoading } from './loading'

/**
 * Backlog 38.3 — rider ask: "With a message telling user more results are
 * coming?" The list already paints each mode combination as its plan lands;
 * what it lacked was a word that more are on the way. The shipped config shows
 * no header text and no skeletons while a search is pending, so the only
 * signal was a spinner rendered AFTER the list — below the fold on a phone.
 * Bike + transit is the slow one (median 8.0 s, n = 24, on the rider's phone),
 * so when it is all that is left the line names it.
 */
export type SearchPendingKind = 'BICYCLE_TRANSIT' | 'MORE'

type SearchLike = {
  pending?: number
  pendingCombos?: Record<string, string>
} | null

/**
 * What the line says, or null for no line. No line once nothing is pending —
 * the last answer and an error both decrement `pending`. A pending query with
 * no recorded combination (14.2's wider re-query, a field-trip batch) is
 * "more results".
 */
export function getSearchPendingKind(
  search: SearchLike | undefined
): SearchPendingKind | null {
  if (!search || !((search.pending ?? 0) > 0)) return null
  const outstanding = Object.values(search.pendingCombos || {})
  if (
    outstanding.length > 0 &&
    outstanding.every((kind) => kind === 'BICYCLE_TRANSIT')
  ) {
    return 'BICYCLE_TRANSIT'
  }
  return 'MORE'
}

const Line = styled.div`
  align-items: center;
  color: #555;
  display: flex;
  font-size: 14px;
  gap: 8px;
  padding: 8px 12px;
`

const SearchPendingLine = ({
  kind
}: {
  kind: SearchPendingKind | null
}): JSX.Element | null => {
  if (!kind) return null
  return (
    <Line aria-live="polite" data-testid="search-pending-line" role="status">
      <InlineLoading />
      <span>
        {kind === 'BICYCLE_TRANSIT' ? (
          <FormattedMessage id="components.SearchPendingLine.bikeTransit" />
        ) : (
          <FormattedMessage id="components.SearchPendingLine.more" />
        )}
      </span>
    </Line>
  )
}

export default SearchPendingLine
