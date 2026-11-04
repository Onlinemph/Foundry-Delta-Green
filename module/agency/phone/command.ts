/**
 * /phone             open your phone (a picker if you carry several); GMs get the Handler console
 * /phone burner      open your burner
 * /phone smartphone  open your smartphone
 */
import ChatProcessor from '../../chat/chat-processor.js'

export class PhoneChatProcessor extends ChatProcessor {
  private arg = ''

  constructor(private readonly open: (kind: string) => void) {
    super()
  }

  override help() {
    return '/phone [burner|smartphone]'
  }

  override matches(line: string) {
    const match = line.match(/^\/phone(?:\s+(\S+))?\s*$/i)
    this.arg = (match?.[1] ?? '').toLowerCase()
    return !!match
  }

  override async process(_line: string) {
    this.open(this.arg)
    return true
  }
}
