import { Rss } from '@styled-icons/fa-solid/Rss'
import React from 'react'
import styled, { keyframes } from 'styled-components'

interface Props {
  flipHorizontal?: boolean
  rotate90?: boolean
  size?: string
  spin?: boolean
  style?: Record<string, any>
  textAlign?: boolean
}

interface IconProps extends Props {
  Icon?: React.ElementType
  icon?: JSX.Element
}

interface IconPropsWithText extends Props {
  Icon?: React.ElementType
  children: React.ReactNode
  icon?: JSX.Element
  styleProps?: React.CSSProperties
}

const getFontSize = (size?: string) => {
  switch (size) {
    case '1.5x':
      return '1.5em'
    case '2x':
      return '2em'
    case '3x':
      return '3em'
    case '4x':
      return '4em'
    case '5x':
      return '5em'
    default:
      return 'inherit'
  }
}

export const PulsingRss = styled(Rss)`
  animation: pulse-opacity 2s ease-in-out infinite;
  transform: scaleX(-1);

  /* Phone layout: the live glyph in the realtime green. */
  .tn-mobile & {
    color: var(--tn-live);
  }
`

const rotateAnimation = keyframes`
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
`

export const StyledIconWrapper = styled.span<Props>`
  animation: ${(props) => (props.spin ? rotateAnimation : 'none')} 1s linear
    infinite;
  display: ${(props) => (props.spin ? 'inline-block' : 'initial')};
  svg {
    font-size: ${(props) => getFontSize(props.size)};
    height: 1em;
    transform: ${(props) => `
      ${props.flipHorizontal ? 'scale(-1,1) ' : ''}
      ${props.rotate90 ? 'rotate(90deg)' : ''}
    `};
    width: 1em;
  }
`

export const StyledIconWrapperTextAlign = styled(StyledIconWrapper)<Props>`
  svg {
    margin: -0.125em 0;
    vertical-align: baseline;
  }
  &:after {
    margin: 0 0.125em;
    content: '';
  }
`

export const IconWithText = ({
  children,
  Icon,
  icon,
  size,
  spin,
  styleProps = { display: 'contents' }
}: IconPropsWithText): React.ReactElement => {
  return (
    // A span, not a div: IconWithText also renders inside <p> (e.g. the
    // pattern row's day label), and a div there trips React's DOM nesting
    // validation. Default display:contents keeps every layout unchanged.
    <span style={styleProps}>
      <StyledIconWrapperTextAlign size={size} spin={spin}>
        {Icon && <Icon />}
        {icon}
      </StyledIconWrapperTextAlign>
      <span>{children}</span>
    </span>
  )
}

export const Icon = ({
  Icon,
  icon,
  ...props
}: IconProps): React.ReactElement => (
  <StyledIconWrapper {...props}>
    {Icon && <Icon />}
    {icon}
  </StyledIconWrapper>
)
