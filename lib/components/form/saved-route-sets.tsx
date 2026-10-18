import { FormattedMessage, useIntl } from 'react-intl'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

import {
  MAX_ROUTE_SETS,
  RouteSet,
  routeSetLabels,
  RouteSetWrite,
  splitRunningRoutes
} from '../../util/route-sets'
import type { LockableRoute, LockedRoute } from '../../util/route-lock'

import {
  ChipRow,
  HelperText,
  PanelPrimaryButton,
  PanelSecondaryButton,
  PanelTextInput,
  SavedSetChip
} from './styled'

/**
 * Saved route sets (58.2, cycle 27 Q3 = B), the three pieces of UI:
 *
 * - SavedSetChips: the "Saved sets" row on top of the route sheet —
 *   "Commute · 3"; one tap puts that set back and searches once.
 * - SaveSetForm: "Save this set…" beside the sheet's Done — an inline name
 *   field, and "Replace Commute?" when the name is taken.
 * - SavedRouteSetList: the list in Settings under the route chips — Use,
 *   Rename (inline), Delete (a second tap confirms).
 *
 * A saved set can name a route the graph no longer has (a seasonal route, a
 * renumbering). Such routes are named back next to the set ("Route 99 in
 * Commute isn't running") and left out when it is used; the saved set itself
 * is left alone, so the route comes back with the next graph that has it.
 */

const SavedSection = styled.section`
  margin: 4px 0 8px;
`

// In Settings the list sits under the route chips' helper line: give it air.
const ListSection = styled(SavedSection)`
  margin-top: 20px;
`

const SectionLabel = styled.div`
  color: #555;
  font-size: 13px;
  font-weight: 600;
  margin: 8px 0 2px;
`

const Note = styled(HelperText)`
  margin: 4px 0;
`

const InlineRow = styled.div`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;

  input {
    flex: 1 1 160px;
    min-height: 44px;
    min-width: 0;
  }
`

const InlinePrimary = styled(PanelPrimaryButton)`
  margin-top: 0;
  min-height: 44px;
  min-width: 44px;
`

const SetList = styled.ul`
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
`

const SetItem = styled.li`
  border-top: 1px solid #eee;
  padding: 8px 0;
`

const SetName = styled.div`
  font-weight: 600;
`

const SetRoutes = styled.div`
  color: #555;
  font-size: 13px;
  overflow-wrap: anywhere;
`

const SetActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
`

const DangerButton = styled(PanelSecondaryButton)<{ confirming?: boolean }>`
  border-color: ${(p) => (p.confirming ? '#d32f2f' : '#ccc')};
  color: ${(p) => (p.confirming ? '#d32f2f' : '#333')};
`

/** "Route 99 in Commute isn't running", or nothing. */
function MissingNote({
  missing,
  running,
  set
}: {
  missing: LockedRoute[]
  running: LockedRoute[]
  set: RouteSet
}): JSX.Element | null {
  if (missing.length === 0) return null
  if (running.length === 0) {
    return (
      <Note className="route-set-missing">
        <FormattedMessage
          id="components.BatchSearchScreen.routeSetNoneRunning"
          values={{ name: set.name }}
        />
      </Note>
    )
  }
  return (
    <Note className="route-set-missing">
      <FormattedMessage
        id="components.BatchSearchScreen.routeSetNotRunning"
        values={{
          count: missing.length,
          name: set.name,
          routes: missing.map((route) => route.label).join(', ')
        }}
      />
    </Note>
  )
}

/** The sheet's "Saved sets" chip row. Renders nothing with no sets. */
export function SavedSetChips({
  disabled,
  graphRoutes,
  onUse,
  sets
}: {
  disabled?: boolean
  graphRoutes?: Record<string, LockableRoute>
  /** The set, and its routes the graph still has. */
  onUse: (set: RouteSet, runningIds: string[]) => void
  sets: RouteSet[]
}): JSX.Element | null {
  const intl = useIntl()
  if (sets.length === 0) return null
  const split = sets.map((set) => ({
    set,
    ...splitRunningRoutes(set, graphRoutes)
  }))
  return (
    <SavedSection className="route-set-saved">
      <SectionLabel>
        <FormattedMessage id="components.BatchSearchScreen.routeSetSavedHeader" />
      </SectionLabel>
      <ChipRow>
        {split.map(({ running, set }) => (
          <SavedSetChip
            aria-label={intl.formatMessage(
              { id: 'components.BatchSearchScreen.routeSetUseLabel' },
              { name: set.name }
            )}
            className="route-set-saved-chip"
            disabled={disabled || running.length === 0}
            key={set.id}
            onClick={() => {
              onUse(
                set,
                running.map((route) => route.id)
              )
            }}
            title={routeSetLabels(set)}
            type="button"
          >
            <FormattedMessage
              id="components.BatchSearchScreen.routeSetSavedChip"
              values={{ count: set.routes.length, name: set.name }}
            />
          </SavedSetChip>
        ))}
      </ChipRow>
      {split.map(({ missing, running, set }) => (
        <MissingNote
          key={set.id}
          missing={missing}
          running={running}
          set={set}
        />
      ))}
    </SavedSection>
  )
}

/** "Save this set…" → name field → Save (→ "Replace Commute?"). */
export function SaveSetForm({
  count,
  onSave
}: {
  /** Routes ticked in the sheet right now. */
  count: number
  onSave: (name: string, replace: boolean) => RouteSetWrite
}): JSX.Element | null {
  const intl = useIntl()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [replaceName, setReplaceName] = useState<string | null>(null)
  const [message, setMessage] = useState<JSX.Element | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const reset = useCallback(() => {
    setEditing(false)
    setReplaceName(null)
    setName('')
  }, [])

  const save = useCallback(
    (replace: boolean) => {
      const result = onSave(name, replace)
      if (result.ok) {
        reset()
        setMessage(
          <FormattedMessage
            id="components.BatchSearchScreen.routeSetSavedAs"
            values={{ name: result.set.name }}
          />
        )
        return
      }
      if (result.error === 'exists' && result.existing) {
        setReplaceName(result.existing.name)
        return
      }
      if (result.error === 'full') {
        reset()
        setMessage(
          <FormattedMessage
            id="components.BatchSearchScreen.routeSetFull"
            values={{ max: MAX_ROUTE_SETS }}
          />
        )
      }
    },
    [name, onSave, reset]
  )

  if (count === 0 && !editing) {
    return message ? (
      <Note className="route-set-save-note">{message}</Note>
    ) : null
  }

  if (!editing) {
    return (
      <>
        <PanelSecondaryButton
          className="route-set-save-open"
          onClick={() => {
            setMessage(null)
            setEditing(true)
          }}
          type="button"
        >
          <FormattedMessage id="components.BatchSearchScreen.routeSetSaveOpen" />
        </PanelSecondaryButton>
        {message && <Note className="route-set-save-note">{message}</Note>}
      </>
    )
  }

  if (replaceName) {
    return (
      <InlineRow className="route-set-replace">
        <span>
          <FormattedMessage
            id="components.BatchSearchScreen.routeSetReplaceAsk"
            values={{ name: replaceName }}
          />
        </span>
        <InlinePrimary
          className="route-set-replace-yes"
          onClick={() => save(true)}
          type="button"
        >
          <FormattedMessage id="components.BatchSearchScreen.routeSetReplace" />
        </InlinePrimary>
        <PanelSecondaryButton
          className="route-set-replace-no"
          onClick={() => setReplaceName(null)}
          type="button"
        >
          <FormattedMessage id="common.forms.cancel" />
        </PanelSecondaryButton>
      </InlineRow>
    )
  }

  return (
    <form
      className="route-set-save-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && count > 0) save(false)
      }}
    >
      <InlineRow>
        <PanelTextInput
          aria-label={intl.formatMessage({
            id: 'components.BatchSearchScreen.routeSetNameLabel'
          })}
          className="route-set-name"
          enterKeyHint="done"
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder={intl.formatMessage({
            id: 'components.BatchSearchScreen.routeSetNamePlaceholder'
          })}
          ref={inputRef}
          type="text"
          value={name}
        />
        <InlinePrimary
          className="route-set-save"
          disabled={!name.trim() || count === 0}
          type="submit"
        >
          <FormattedMessage id="components.BatchSearchScreen.routeSetSave" />
        </InlinePrimary>
        <PanelSecondaryButton
          className="route-set-save-cancel"
          onClick={reset}
          type="button"
        >
          <FormattedMessage id="common.forms.cancel" />
        </PanelSecondaryButton>
      </InlineRow>
    </form>
  )
}

/** One set in the Settings list: Use / Rename / Delete. */
function SavedSetRow({
  active,
  graphRoutes,
  onDelete,
  onRename,
  onUse,
  set
}: {
  active: boolean
  graphRoutes?: Record<string, LockableRoute>
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => RouteSetWrite
  onUse: (id: string) => void
  set: RouteSet
}): JSX.Element {
  const intl = useIntl()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(set.name)
  const [taken, setTaken] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { missing, running } = splitRunningRoutes(set, graphRoutes)

  // "Tap again to delete" lapses on its own: a stray tap minutes later must
  // not delete anything.
  useEffect(() => {
    if (!confirmDelete) return
    const timer = setTimeout(() => setConfirmDelete(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmDelete])

  const submitRename = () => {
    const result = onRename(set.id, name)
    if (result.ok) {
      setRenaming(false)
      setTaken(null)
    } else if (result.error === 'exists' && result.existing) {
      setTaken(result.existing.name)
    }
  }

  return (
    <SetItem className="route-set-item">
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) submitRename()
          }}
        >
          <InlineRow>
            <PanelTextInput
              aria-label={intl.formatMessage({
                id: 'components.BatchSearchScreen.routeSetNameLabel'
              })}
              className="route-set-rename-input"
              maxLength={60}
              onChange={(e) => {
                setName(e.target.value)
                setTaken(null)
              }}
              type="text"
              value={name}
            />
            <InlinePrimary
              className="route-set-rename-save"
              disabled={!name.trim()}
              type="submit"
            >
              <FormattedMessage id="components.BatchSearchScreen.routeSetSave" />
            </InlinePrimary>
            <PanelSecondaryButton
              onClick={() => {
                setRenaming(false)
                setName(set.name)
                setTaken(null)
              }}
              type="button"
            >
              <FormattedMessage id="common.forms.cancel" />
            </PanelSecondaryButton>
          </InlineRow>
          {taken && (
            <Note className="route-set-name-taken">
              <FormattedMessage
                id="components.BatchSearchScreen.routeSetNameTaken"
                values={{ name: taken }}
              />
            </Note>
          )}
        </form>
      ) : (
        <SetName className="route-set-item-name">{set.name}</SetName>
      )}
      <SetRoutes className="route-set-item-routes">
        {routeSetLabels(set)}
      </SetRoutes>
      <MissingNote missing={missing} running={running} set={set} />
      {!renaming && (
        <SetActions>
          <PanelSecondaryButton
            aria-label={intl.formatMessage(
              { id: 'components.BatchSearchScreen.routeSetUseLabel' },
              { name: set.name }
            )}
            className="route-set-use"
            disabled={active || running.length === 0}
            onClick={() => onUse(set.id)}
            type="button"
          >
            {active ? (
              <FormattedMessage id="components.BatchSearchScreen.routeSetInUse" />
            ) : (
              <FormattedMessage id="components.BatchSearchScreen.routeSetUse" />
            )}
          </PanelSecondaryButton>
          <PanelSecondaryButton
            className="route-set-rename"
            onClick={() => {
              setName(set.name)
              setRenaming(true)
              setConfirmDelete(false)
            }}
            type="button"
          >
            <FormattedMessage id="components.BatchSearchScreen.routeSetRename" />
          </PanelSecondaryButton>
          <DangerButton
            className="route-set-delete"
            confirming={confirmDelete}
            onClick={() => {
              if (confirmDelete) onDelete(set.id)
              else setConfirmDelete(true)
            }}
            type="button"
          >
            {confirmDelete ? (
              <FormattedMessage id="components.BatchSearchScreen.routeSetDeleteConfirm" />
            ) : (
              <FormattedMessage id="components.BatchSearchScreen.routeSetDelete" />
            )}
          </DangerButton>
        </SetActions>
      )}
    </SetItem>
  )
}

/** Settings' "Saved sets" list. Renders nothing with no sets. */
export function SavedRouteSetList({
  activeSetId,
  graphRoutes,
  onDelete,
  onRename,
  onUse,
  sets
}: {
  /** The saved set the query's lock is, if any (matchSavedSet). */
  activeSetId?: string
  graphRoutes?: Record<string, LockableRoute>
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => RouteSetWrite
  onUse: (id: string) => void
  sets: RouteSet[]
}): JSX.Element | null {
  if (sets.length === 0) return null
  return (
    <ListSection className="route-set-saved-list">
      <SectionLabel>
        <FormattedMessage id="components.BatchSearchScreen.routeSetSavedHeader" />
      </SectionLabel>
      <SetList>
        {sets.map((set) => (
          <SavedSetRow
            active={set.id === activeSetId}
            graphRoutes={graphRoutes}
            key={set.id}
            onDelete={onDelete}
            onRename={onRename}
            onUse={onUse}
            set={set}
          />
        ))}
      </SetList>
    </ListSection>
  )
}
