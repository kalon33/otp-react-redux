import { connectRouter, routerMiddleware } from 'connected-react-router'
import { createHashHistory } from 'history'
import { IntlProvider } from 'react-intl'
import { mountToJson } from 'enzyme-to-json'
import { Provider } from 'react-redux'
import clone from 'lodash/cloneDeep'
import configureStore from 'redux-mock-store'
import Enzyme, { mount } from 'enzyme'
import EnzymeReactAdapter from 'enzyme-adapter-react-16'
import React from 'react'
import thunk from 'redux-thunk'

import { getInitialState } from '../../../lib/reducers/create-otp-reducer'
import { getUserInitialState } from '../../../lib/reducers/create-user-reducer'

Enzyme.configure({ adapter: new EnzymeReactAdapter() })

const history = createHashHistory()
const storeMiddleWare = [
  thunk,
  routerMiddleware(history) // for dispatching history actions
]

/**
 * Get the initial stop of the redux reducer for otp-rr
 */
export function getMockInitialState() {
  const mockConfig = {
    // 75.37 (J5): getOtpFetchOptions (lib/actions/api.js) destructures
    // `state.otp.config.api`; without one every OTP fetch a component test
    // triggers died on "reading 'host'" before a request was built, so those
    // suites exercised the crash path. An unresolvable host keeps a stray
    // request off any real server (jest's testURL is the :9966 front door).
    api: { host: 'http://mock-otp.invalid', path: '/otp', port: 80 },
    dateTime: { timeFormat: 'h:mm a' },
    initialQuery: {}
  }
  return clone({
    otp: getInitialState(mockConfig),
    router: connectRouter(history),
    user: getUserInitialState(mockConfig)
  })
}

/**
 * Mount a react component within a mock redux store. This mock redux store
 * accepts actions, but doesn't send any of those results to the reducers.
 * This function is primarily used for taking snapshots of components and
 * containers in order to verify that they are rendering expected values.
 */
export function mockWithProvider(
  ConnectedComponent,
  connectedComponentProps,
  storeState = getMockInitialState(),
  // Jest maps i18n/*.yml to an empty object, so FormattedMessage normally
  // renders message ids. Pass real (flattened) messages to assert on the copy
  // a rider actually sees.
  messages = undefined
) {
  const store = configureStore(storeMiddleWare)(storeState)
  const wrapper = mount(
    <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
      <Provider store={store}>
        <ConnectedComponent {...connectedComponentProps} />
      </Provider>
    </IntlProvider>
  )

  return {
    snapshot: () => mountToJson(wrapper),
    store,
    wrapper
  }
}
