// 构造 XML 文本回复
export function buildTextReply(msg, content: string) {
  return `
      <xml>
        <ToUserName><![CDATA[${msg.FromUserName}]]></ToUserName>
        <FromUserName><![CDATA[${msg.ToUserName}]]></FromUserName>
        <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[${content}]]></Content>
      </xml>
    `;
}
