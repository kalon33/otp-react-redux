import { FormattedMessage, useIntl } from 'react-intl'
import { QueryParamChangeEvent } from '@opentripplanner/trip-form/lib/types'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'

import {
  AnyRouteLock,
  LockableRoute,
  routeLockIds,
  routeLockLabel,
  routeLockScope,
  RouteLockScope
} from '../../util/route-lock'
import {
  BoardingOverlay,
  BoardingSheet,
  BoardingSubtitle,
  BoardingTitle,
  SheetCloseButton,
  SheetHeader,
  SheetSectionTitle
} from '../go-mode/styled'
import { isFilterMatch } from '../../util/state'
import type { RouteSetSource } from '../../actions/route-lock'

import {
  HelperText,
  PanelPrimaryButton,
  PanelTextInput,
  SettingDropdown
} from './styled'

/**
 * Rider ask 58.2: "whitelist a certain set of routes … can only pick one".
 *
 * The Settings panel used to offer one route per open of a native select, and
 * every pick ran a whole search. This is the replacement: one button in
 * Settings opens a sheet with every route as a checkbox, the routes of the
 * last search between the same two places on top (cycle 27 Q1), and one Done
 * that writes the whole set and searches once (Q2). Ticking inside the sheet
 * changes nothing until Done — the draft is this component's own state.
 *
 * The sheet borrows the Go Mode bottom sheet (BoardingOverlay/BoardingSheet
 * and its header pieces) so it slides, rounds and shadows like every other
 * sheet in the app, and the panel's own text field, dropdown and button.
 */

// The full route list is ~145 rows: give the sheet the height of the screen
// less a strip of the panel behind it, and let it scroll inside.
const RouteSheet = styled(BoardingSheet)`
  display: flex;
  flex-direction: column;
  max-height: 88vh;
  padding-bottom: 0;
`

const SheetIntro = styled.div`
  flex-shrink: 0;

  /* The Go Mode sheets' × and the panel's text field, made thumb-sized. */
  ${SheetCloseButton} {
    min-height: 44px;
    min-width: 44px;
  }
  input {
    min-height: 44px;
  }
`

const RouteList = styled.div`
  flex: 1 1 auto;
  margin: 0 -16px;
  min-height: 120px;
  overflow-y: auto;
  padding: 0 16px;
`

const RouteGroup = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`

// One route, the whole row a tap target (>= 44px tall): the checkbox, the
// rider's name for the route and, when it has one, the long name.
const RouteRow = styled.label`
  align-items: center;
  border-bottom: 1px solid #eee;
  cursor: pointer;
  display: flex;
  font-weight: 400;
  gap: 12px;
  margin: 0;
  min-height: 44px;
  padding: 8px 2px;

  input[type='checkbox'] {
    flex-shrink: 0;
    height: 20px;
    margin: 0;
    width: 20px;
  }
`

const RouteName = styled.span`
  font-weight: 600;
`

const RouteLongName = styled.span`
  color: #666;
  font-size: 13px;
`

// Done stays on screen however far the list is scrolled.
const SheetFooter = styled.div`
  background: #fff;
  border-top: 1px solid #eee;
  flex-shrink: 0;
  margin: 0 -16px;
  padding: 4px 16px 16px;

  > div {
    margin: 8px 0;
  }

  select {
    min-height: 44px;
  }
`

const DoneButton = styled(PanelPrimaryButton)`
  font-size: 16px;
  min-height: 44px;
  width: 100%;
`

// Same trigger look as the panel's text fields, so it reads as a control and
// not as another heading.
const OpenButton = styled.button`
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  font: inherit;
  min-height: 44px;
  padding: 8px;
  text-align: left;
  width: 100%;
`

/** One row of the checklist. */
interface RouteOption {
  id: string
  label: string
  longName?: string
  sortOrder: number
}

/**
 * The index as checklist rows, in the order the route viewer lists them.
 * Vehicle-position updates stash bare {vehicles} entries under a route id;
 * those aren't pickable routes and are left out.
 */
function routeOptions(routes?: Record<string, LockableRoute>): RouteOption[] {
  return Object.entries(routes || {})
    .filter(([, route]) => route.shortName || route.longName)
    .map(([id, route]) => {
      const label = routeLockLabel({ ...route, id })
      return {
        id,
        label,
        longName:
          route.longName && route.longName !== label
            ? route.longName
            : undefined,
        sortOrder: route.sortOrder ?? Number.MAX_SAFE_INTEGER
      }
    })
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.label.localeCompare(b.label, undefined, { numeric: true })
    )
}

function matchesFilter(option: RouteOption, filter: string): boolean {
  if (!filter) return true
  return (
    isFilterMatch(option.label, filter) ||
    (!!option.longName && isFilterMatch(option.longName, filter))
  )
}

interface SheetProps {
  /** Route ids of the last search between these places, best trip first. */
  lastResultRouteIds: string[]
  lock?: AnyRouteLock | null
  /** Write the set and search. Resolves once the set is on the query. */
  onApply: (
    routeIds: string[],
    scope: RouteLockScope,
    source: RouteSetSource
  ) => Promise<void> | void
  onCancel: () => void
  routes?: Record<string, LockableRoute>
}

/** The sheet itself: the draft set, its filter, and Done. */
export function RouteSetSheet({
  lastResultRouteIds,
  lock,
  onApply,
  onCancel,
  routes
}: SheetProps): JSX.Element {
  const intl = useIntl()
  const [picked, setPicked] = useState<string[]>(() => routeLockIds(lock))
  const [scope, setScope] = useState<RouteLockScope>(() => routeLockScope(lock))
  const [filter, setFilter] = useState('')
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const options = useMemo(() => routeOptions(routes), [routes])
  const query = filter.trim()
  const lastResults = useMemo(() => {
    const byId = new Map(options.map((option) => [option.id, option]))
    return lastResultRouteIds
      .map((id) => byId.get(id))
      .filter((option): option is RouteOption => !!option)
  }, [lastResultRouteIds, options])
  const lastIds = useMemo(
    () => new Set(lastResults.map((option) => option.id)),
    [lastResults]
  )
  const shownLast = lastResults.filter((option) => matchesFilter(option, query))
  const shownAll = options.filter(
    (option) => !lastIds.has(option.id) && matchesFilter(option, query)
  )

  const toggle = useCallback((id: string) => {
    setPicked((current) =>
      current.includes(id)
        ? current.filter((routeId) => routeId !== id)
        : [...current, id]
    )
  }, [])

  const apply = useCallback(
    async (
      routeIds: string[],
      nextScope: RouteLockScope,
      source: RouteSetSource
    ) => {
      setApplying(true)
      try {
        await onApply(routeIds, nextScope, source)
      } catch (e) {
        // Leave the sheet usable: Done again is the rider's retry.
        setApplying(false)
        throw e
      }
    },
    [onApply]
  )

  const onScopeChange = useCallback(
    (evt: QueryParamChangeEvent) =>
      setScope(evt.routeSetScope as RouteLockScope),
    []
  )

  const scopeOptions = useMemo(
    () => [
      {
        text: intl.formatMessage({
          id: 'components.BatchSearchScreen.routeLockScopeOnly'
        }),
        value: 'only'
      },
      {
        text: intl.formatMessage({
          id: 'components.BatchSearchScreen.routeLockScopeStarting'
        }),
        value: 'starting'
      }
    ],
    [intl]
  )

  const renderRow = (option: RouteOption) => (
    <li key={option.id}>
      <RouteRow className="route-set-row">
        <input
          checked={picked.includes(option.id)}
          onChange={() => toggle(option.id)}
          type="checkbox"
          value={option.id}
        />
        <span>
          <RouteName>{option.label}</RouteName>
          {option.longName && (
            <>
              {' '}
              <RouteLongName>{option.longName}</RouteLongName>
            </>
          )}
        </span>
      </RouteRow>
    </li>
  )

  const title = intl.formatMessage({
    id: 'components.BatchSearchScreen.routeSetTitle'
  })

  return (
    <>
      <BoardingOverlay className="route-set-overlay" onClick={onCancel} />
      <RouteSheet aria-label={title} className="route-set-sheet" role="dialog">
        <SheetIntro>
          <SheetHeader>
            <BoardingTitle>{title}</BoardingTitle>
            <SheetCloseButton
              aria-label={intl.formatMessage({ id: 'common.forms.close' })}
              onClick={onCancel}
              type="button"
            >
              ×
            </SheetCloseButton>
          </SheetHeader>
          <BoardingSubtitle className="route-set-count">
            <FormattedMessage
              id="components.BatchSearchScreen.routeSetPicked"
              values={{ count: picked.length }}
            />
          </BoardingSubtitle>
          <PanelTextInput
            aria-label={intl.formatMessage({
              id: 'components.BatchSearchScreen.routeSetFilter'
            })}
            className="route-set-filter"
            onChange={(e) => setFilter(e.target.value)}
            placeholder={intl.formatMessage({
              id: 'components.BatchSearchScreen.routeSetFilter'
            })}
            type="search"
            value={filter}
          />
        </SheetIntro>
        <RouteList className="route-set-list">
          {options.length === 0 && (
            <HelperText>
              <FormattedMessage id="components.BatchSearchScreen.routeSetLoading" />
            </HelperText>
          )}
          {shownLast.length > 0 && (
            <section className="route-set-last-results">
              <SheetSectionTitle>
                <FormattedMessage id="components.BatchSearchScreen.routeSetLastResults" />
              </SheetSectionTitle>
              <RouteGroup>{shownLast.map(renderRow)}</RouteGroup>
            </section>
          )}
          {shownAll.length > 0 && (
            <section className="route-set-all">
              <SheetSectionTitle>
                <FormattedMessage id="components.BatchSearchScreen.routeSetAll" />
              </SheetSectionTitle>
              <RouteGroup>{shownAll.map(renderRow)}</RouteGroup>
            </section>
          )}
          {options.length > 0 &&
            query &&
            shownLast.length === 0 &&
            shownAll.length === 0 && (
              <HelperText>
                <FormattedMessage
                  id="components.BatchSearchScreen.routeSetNoMatch"
                  values={{ filter: query }}
                />
              </HelperText>
            )}
        </RouteList>
        <SheetFooter>
          <SettingDropdown
            label={intl.formatMessage({
              id: 'components.BatchSearchScreen.routeLockScopeLabel'
            })}
            name="routeSetScope"
            onChange={onScopeChange}
            options={scopeOptions}
            value={scope}
          />
          <DoneButton
            className="route-set-done"
            disabled={applying}
            onClick={() => apply(picked, scope, 'sheet')}
            type="button"
          >
            <FormattedMessage id="components.BatchSearchScreen.routeSetDone" />
          </DoneButton>
        </SheetFooter>
      </RouteSheet>
    </>
  )
}

interface PickerProps extends Omit<SheetProps, 'onCancel'> {
  /** Called once the sheet's set is written; the panel closes and searches. */
  onApply: SheetProps['onApply']
}

/**
 * The Settings row: "Choose routes (N picked)", opening the sheet. The chips
 * and the scope control for the set already in place stay in the panel.
 */
export default function RouteSetPicker({
  lastResultRouteIds,
  lock,
  onApply,
  routes
}: PickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  // Done closes Settings too, which unmounts this row before onApply settles.
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  const count = routeLockIds(lock).length
  const close = useCallback(() => setOpen(false), [])
  const applyAndClose = useCallback(
    async (
      routeIds: string[],
      scope: RouteLockScope,
      source: RouteSetSource
    ) => {
      await onApply(routeIds, scope, source)
      if (mounted.current) setOpen(false)
    },
    [onApply]
  )
  return (
    <>
      <OpenButton
        aria-haspopup="dialog"
        className="route-set-open"
        onClick={() => setOpen(true)}
        type="button"
      >
        <FormattedMessage
          id="components.BatchSearchScreen.routeSetOpen"
          values={{ count }}
        />
      </OpenButton>
      {open && (
        <RouteSetSheet
          lastResultRouteIds={lastResultRouteIds}
          lock={lock}
          onApply={applyAndClose}
          onCancel={close}
          routes={routes}
        />
      )}
    </>
  )
}
