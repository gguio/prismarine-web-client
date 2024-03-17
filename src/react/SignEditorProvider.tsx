import { useMemo, useEffect, useState, useRef } from 'react'
import { showModal, hideModal } from '../globalState'
import { MessageFormatPart } from '../botUtils'
import { setDoPreventDefault } from '../controls'
import { options } from '../optionsStorage'
import { useIsModalActive } from './utils'
import SignEditor from './SignEditor'


const isWysiwyg = async () => {
  const items = await bot.tabComplete('/', true, true)
  const commands = new Set<string>(['data'])
  for (const item of items) {
    if (commands.has(item.match as unknown as string)) {
      return true
    }
  }
  return false
}

export default () => {
  const [location, setLocation] = useState<{x: number, y: number, z: number} | null>(null)
  const text = useRef<MessageFormatPart[]>([])
  const [enableWysiwyg, setEnableWysiwyg] = useState(false)
  const isModalActive = useIsModalActive('signs-editor-screen')

  const handleClick = () => {
    hideModal({ reactType: 'signs-editor-screen' })
  }

  const handleInput = (target: HTMLInputElement) => {
    const specialSymbols = /[;|',.()[\]{} ]/
    let addLength = 0
    for (const letter of target.value) {
      if (specialSymbols.test(letter)) {
        addLength += 1 - 1 / 1.46
      } 
    }
    if (text.current.length < Number(target.dataset.key) + 1) {
      text.current.push({ text: target.value })
    } else {
      text.current[Number(target.dataset.key)] = { text: target.value }
    }
    target.setAttribute('maxlength', `${15 + Math.ceil(addLength)}`)
  }

  useEffect(() => {
    setDoPreventDefault(!isModalActive) // disable e.preventDefault() since we might be using wysiwyg editor which doesn't use textarea and need default browser behavior to ensure characters are being typed in contenteditable container. Ideally we should do e.preventDefault() only when either ctrl, cmd (meta) or alt key is pressed.

    if (!isModalActive) {
      if (location) {
        bot._client.write('update_sign', {
          location,
          text1: text.current[0] ? JSON.stringify(text.current[0]) : '',
          text2: text.current[1] ? JSON.stringify(text.current[1]) : '',
          text3: text.current[2] ? JSON.stringify(text.current[2]) : '',
          text4: text.current[3] ? JSON.stringify(text.current[3]) : ''
        })
      }
    }
  }, [isModalActive])

  useMemo(() => {
    bot._client.on('open_sign_entity', (packet) => {
      if (!options.autoSignEditor) return
      setLocation(prev => packet.location)
      showModal({ reactType: 'signs-editor-screen' })
      if (options.wysiwygSignEditor === 'auto') {
        void isWysiwyg().then((value) => {
          setEnableWysiwyg(value)
        })
      } else if (options.wysiwygSignEditor === 'always') {
        setEnableWysiwyg(true)
      } else {
        setEnableWysiwyg(false)
      }
    })
  }, [])

  if (!isModalActive) return null
  return <SignEditor isWysiwyg={enableWysiwyg} handleInput={handleInput} handleClick={handleClick} />
}
