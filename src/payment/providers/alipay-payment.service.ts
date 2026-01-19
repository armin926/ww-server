import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlipaySdk } from 'alipay-sdk';
import { PaymentChannel, PaymentOrderPayload } from '../payment.types';

/**
 * 支付宝支付服务
 * 负责：
 * 1. 创建支付订单（生成二维码）
 * 2. 校验支付宝异步通知签名
 * 3. 处理支付结果回调
 * 4. 查询订单状态
 */
@Injectable()
export class AlipayPaymentService {
  /** NestJS 日志实例，用于记录支付相关日志 */
  private readonly logger = new Logger(AlipayPaymentService.name);

  /** 支付宝网关地址 */
  private readonly gateway: string;

  /** 支付宝应用 AppId */
  private readonly appId: string;

  /** 商户私钥，用于请求签名 */
  private readonly privateKey: string;

  /** 支付宝公钥，用于验签 */
  private readonly alipayPublicKey: string;

  /** 支付宝异步通知回调地址 */
  private readonly notifyUrl: string;

  /** 支付宝 SDK 实例，封装了接口调用与签名逻辑 */
  private readonly alipaySdk: AlipaySdk;

  /**
   * 构造函数：从配置中心读取支付宝相关配置，并初始化 AlipaySdk
   */
  constructor(private readonly configService: ConfigService) {
    // 支付宝网关地址，未配置时使用正式环境默认地址
    this.gateway =
      this.configService.get<string>('ALIPAY_GATEWAY') ||
      'https://openapi.alipay.com/gateway.do';

    // 支付宝应用 AppId
    this.appId = this.configService.get<string>('ALIPAY_APP_ID') || '';

    // 商户私钥（用于请求签名）
    this.privateKey =
      this.configService.get<string>('ALIPAY_PRIVATE_KEY') || '';

    // 支付宝公钥（用于验签）
    this.alipayPublicKey =
      this.configService.get<string>('ALIPAY_PUBLIC_KEY') || '';

    // 支付宝异步通知回调地址
    this.notifyUrl = this.configService.get<string>('ALIPAY_NOTIFY_URL') || '';

    // 初始化支付宝 SDK
    this.alipaySdk = new AlipaySdk({
      appId: this.appId,
      privateKey: this.privateKey,
      alipayPublicKey: this.alipayPublicKey,
      gateway: this.gateway,
    });
  }

  /**
   * 创建支付宝支付订单（预下单接口）
   * 主要用于生成支付二维码
   *
   * @param payload 支付订单信息（业务侧传入）
   * @returns 统一封装后的支付订单结果
   */
  async initiatePayment(payload: PaymentOrderPayload): Promise<any> {
    // 构造支付宝接口所需的 bizContent 参数
    const bizContent: Record<string, any> = {
      // 商户订单号（业务系统生成，需全局唯一）
      out_trade_no: payload.orderId,

      // 订单总金额，单位：元，保留两位小数
      // TODO：当前可能用于测试环境，临时改为 0.01 元
      total_amount: payload.amount.toFixed(2),

      // 订单标题，用于在支付宝页面展示
      subject: '汪汪职道-' + payload.planName,

      // 销售产品码，对应支付宝签约的产品类型
      // QR_CODE_OFFLINE：当面付扫码支付
      product_code: 'QR_CODE_OFFLINE',
    };

    // 如果存在扩展业务参数，则作为 passback_params 透传给回调
    if (payload.metadata) {
      bizContent.passback_params = encodeURIComponent(
        JSON.stringify(payload.metadata),
      );
    }

    try {
      /**
       * 调用支付宝预创建订单接口（alipay.trade.precreate）
       * 官方文档：
       * https://opendocs.alipay.com/open/8ad49e4a_alipay.trade.precreate
       */
      const response = await this.alipaySdk.exec('alipay.trade.precreate', {
        bizContent,
        // 优先使用本次订单指定的 notifyUrl，否则使用全局配置
        notifyUrl: payload.notifyUrl || this.notifyUrl,
      });

      // 记录支付宝返回的原始响应，便于问题排查
      this.logger.log('支付宝支付订单响应：', response);

      // 将支付宝返回结果，转换为系统内部统一的支付创建结果格式
      return {
        // 支付渠道标识
        channel: PaymentChannel.ALIPAY,

        // 商户订单号
        orderId: response.outTradeNo,

        // 支付二维码地址，前端可直接生成二维码
        codeUrl: response.qrCode,

        // 订单创建时间（ISO 字符串）
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      // 记录异常日志，并继续向上抛出，交由上层统一处理
      this.logger.error('调用支付宝创建订单失败', error as Error);
      throw error;
    }
  }

  /**
   * 主动查询订单状态
   * 适用于：
   * - 前端轮询支付结果
   * - 异步通知丢失时的兜底校验
   *
   * @param orderId 商户订单号
   * @returns 支付宝返回的订单状态信息
   */
  async queryTrade(orderId: string): Promise<Record<string, any>> {
    try {
      return await this.alipaySdk.exec('alipay.trade.query', {
        bizContent: { out_trade_no: orderId },
      });
    } catch (error) {
      this.logger.error('调用支付宝订单查询失败', error as Error);
      throw error;
    }
  }
}
