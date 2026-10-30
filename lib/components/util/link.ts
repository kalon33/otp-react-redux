import { AnchorHTMLAttributes, FC } from 'react'
import { connect } from 'react-redux'

import { AppReduxState } from '../../util/state-types'
import { combineQueryParams } from '../../util/api'
import { isBlank } from '../../util/ui'

interface OwnProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to?: string
  toParams?: Record<string, unknown>
  /** If true, an 'active' CSS class will be applied if the URL starts the same as the `to` prop. */
  tracking?: boolean
}

/** Determines whether the given path is a subpath of the 'to' prop. */
export function isSubpath(path: string, to: string): boolean {
  return !isBlank(to) && (path === to || path.startsWith(`${to}/`))
}

/**
 * Renders an anchor element <a> with specified path and query params,
 * that preserves other existing query params.
 * The anchor's own attributes come back through mergeProps, so the element
 * type is loosely cast here — connect() would reject the intrinsic 'a'
 * tag's full JSX signature.
 */
const Link = 'a' as unknown as FC<AnchorHTMLAttributes<HTMLAnchorElement>>

// connect to the redux store so that the search params get updated in timely fashion.

const mapStateToProps = (state: AppReduxState, ownProps: OwnProps) => {
  const { className, to = '', toParams, tracking } = ownProps
  const queryParams = combineQueryParams(toParams)
  const href = `#${to}${isBlank(queryParams) ? '' : `?${queryParams}`}`

  const isActive = tracking && isSubpath(state.router.location.pathname, to)
  return {
    className:
      className && isActive
        ? `${className} active`
        : isActive
        ? 'active'
        : className,
    href
  }
}

// 75.37 (J6): drop the passed to, toParams and tracking props from what reaches
// the <a>. Setting them to `undefined` in mapStateToProps still left the keys
// on the element, and React warns about an unknown camelCase `toParams` prop.
const mergeProps = (
  stateProps: ReturnType<typeof mapStateToProps>,
  _dispatchProps: unknown,
  ownProps: OwnProps
) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { to, toParams, tracking, ...rest } = ownProps
  return { ...rest, ...stateProps }
}

// Pass an empty object as mapDispatchToProps to remove dispatch from the rendered HTML.
export default connect(mapStateToProps, {}, mergeProps)(Link)
