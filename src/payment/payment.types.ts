export enum PaymentChannel {
  ALIPAY = 'alipay',
  WECHAT = 'wechat',
}

/**
 * 创建支付订单时的请求参数结构
 */
export interface PaymentOrderPayload {
  /**
   * 用户 ID
   * 可选字段，部分场景下可能通过 token 或其他上下文获取
   */
  userId?: string;

  /**
   * 业务侧订单唯一标识
   * 通常由业务系统生成，用于订单幂等和对账
   */
  orderId: string;

  /**
   * 支付金额
   * 一般使用最小货币单位（如：分），避免浮点数精度问题
   */
  amount: number;

  /**
   * 购买的套餐/计划 ID
   * 可选字段，用于区分不同的商品或订阅方案
   */
  planId?: string;

  /**
   * 套餐/计划名称
   * 主要用于展示或日志记录
   */
  planName?: string;

  /**
   * 订单来源
   * 如：web、h5、mini-program、app 等
   */
  source?: string;

  /**
   * 订单描述信息
   * 用于支付页面或账单展示
   */
  description?: string;

  /**
   * 货币类型
   * 如：CNY、USD，默认可由后端统一处理
   */
  currency?: string;

  /**
   * 自定义扩展字段
   * 用于透传业务相关的附加信息
   */
  metadata?: Record<string, any>;

  /**
   * 支付结果异步通知地址
   * 支付平台完成支付后回调该地址
   */
  notifyUrl?: string;
}

/**
 * 发起支付后的返回结果结构
 */
export interface PaymentInitiationResult {
  /**
   * 支付渠道
   * 如：微信支付、支付宝、银行卡等
   */
  channel: PaymentChannel;

  /**
   * 业务侧订单 ID
   * 与创建支付订单时的 orderId 保持一致
   */
  orderId: string;

  /**
   * 支付渠道所需的原始参数
   * 不同支付渠道返回结构不同，通常用于前端或 SDK 继续发起支付
   */
  payload?: Record<string, any>;

  /**
   * 跳转支付页面的地址
   * 常用于 H5 或 Web 场景，前端可直接重定向
   */
  redirectUrl?: string;

  /**
   * 二维码地址
   * 常用于 PC 扫码支付场景（如微信 / 支付宝扫码）
   */
  codeUrl?: string;

  /**
   * 支付创建时间
   * ISO 8601 格式字符串，便于前后端统一处理
   */
  createdAt: string;
}
