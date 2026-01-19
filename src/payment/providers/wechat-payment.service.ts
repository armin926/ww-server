import {
  BadRequestException,
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import axios, { AxiosInstance } from 'axios';
import {
  PaymentChannel,
  PaymentInitiationResult,
  PaymentOrderPayload,
} from '../payment.types';
import * as path from 'path';

@Injectable()
export class WechatPaymentService {
  private readonly logger = new Logger(WechatPaymentService.name);
  private readonly appId: string;
  private readonly mchId: string;
  private readonly notifyUrl: string;
  private readonly merchantSerial: string;
  private readonly privateKey: string;
  private readonly apiBaseUrl: string;
  private readonly apiV3Key?: string;
  private readonly httpClient: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    // 服务号的 app id
    this.appId = this.configService.get<string>('WECHAT_PAY_APP_ID') || '';
    // 商户号
    this.mchId = this.configService.get<string>('WECHAT_PAY_MCH_ID') || '';
    // 微信支付回调URL
    this.notifyUrl =
      this.configService.get<string>('WECHAT_PAY_NOTIFY_URL') ||
      'https://resume.lgdsunday.club/payment/callback/wechat';
    // 商户序列号
    this.merchantSerial =
      this.configService.get<string>('WECHAT_PAY_MCH_SERIAL') || '';
    // 商户私钥
    const privateKeyPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'wx_apiclient_key.pem',
    );
    console.log(
      '读取到的路径：',
      path.join(__dirname, '..', '..', '..', 'wx_apiclient_key.pem'),
    );

    const privateKeyRaw =
      privateKeyPath && fs.existsSync(privateKeyPath)
        ? fs.readFileSync(privateKeyPath, 'utf8')
        : this.configService.get<string>('WECHAT_PAY_PRIVATE_KEY') || '';
    this.privateKey = this.formatPrivateKey(privateKeyRaw);
    // 微信支付 API v3 密钥
    this.apiV3Key =
      this.configService.get<string>('WECHAT_PAY_API_V3_KEY') ||
      process.env.WECHAT_PAY_API_V3_KEY;
    // 微信支付 API 基础 URL
    this.apiBaseUrl =
      this.configService.get<string>('WECHAT_PAY_API_BASE') ||
      'https://api.mch.weixin.qq.com';

    if (
      !this.appId ||
      !this.mchId ||
      !this.merchantSerial ||
      !this.privateKey
    ) {
      throw new InternalServerErrorException(
        '微信支付配置缺失，请检查 APP_ID/MCH_ID/MCH_SERIAL/PRIVATE_KEY',
      );
    }

    try {
      crypto.createPrivateKey({ key: this.privateKey });
    } catch (e) {
      throw new InternalServerErrorException(
        '微信支付私钥解析失败，请确认提供的是 apiclient_key.pem 内容或有效路径',
      );
    }

    this.httpClient = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        'User-Agent': 'wwzhidao-server/1.0',
      },
    });
  }

  /**
   * 创建微信支付订单
   * @param payload 支付订单信息
   * @returns 支付订单结果
   */
  async initiatePayment(
    payload: PaymentOrderPayload,
  ): Promise<PaymentInitiationResult> {
    const path = '/v3/pay/transactions/native';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');

    // issue:输入源“/body/attach”映射到值字段“附加数据”字符串规则校验失败，字节数 203，大于最大值 128
    payload.userId = payload.metadata?.userId;

    delete payload.metadata;
    // TODO：临时修改支付金额为 0.01元
    // payload.amount = 0.01;

    const body = this.buildNativeOrderPayload(payload);

    const bodyString = JSON.stringify(body);
    const authorization = this.buildAuthorizationHeader(
      'POST',
      path,
      timestamp,
      nonceStr,
      bodyString,
    );

    try {
      const response = await this.httpClient.post(path, bodyString, {
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });

      return {
        channel: PaymentChannel.WECHAT,
        orderId: payload.orderId,
        codeUrl: response.data.code_url,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('调用微信支付下单接口失败', error as Error, {
        payload,
        response: error?.response?.data,
      });
      throw error;
    }
  }

  private buildNativeOrderPayload(payload: PaymentOrderPayload) {
    const amountInCents = Math.round(Number(payload.amount) * 100);
    if (!Number.isFinite(amountInCents) || amountInCents <= 0) {
      throw new BadRequestException('微信支付金额必须大于0');
    }

    const attach = payload.metadata
      ? JSON.stringify({
          ...payload.metadata,
          timestamp: Date.now(),
        })
      : undefined;

    const sceneInfo = payload.metadata?.scene_info;
    const payerClientIp =
      payload.metadata?.clientIp || payload.metadata?.payer_client_ip;

    const request: Record<string, any> = {
      appid: this.appId,
      mchid: this.mchId,
      description: payload.description,
      out_trade_no: payload.orderId,
      notify_url: payload.notifyUrl || this.notifyUrl,
      amount: {
        total: amountInCents,
        currency: payload.currency || 'CNY',
      },
      attach,
    };

    if (payerClientIp || sceneInfo) {
      request.scene_info = {
        payer_client_ip: payerClientIp || '127.0.0.1',
        ...sceneInfo,
      };
    }

    return request;
  }

  private buildAuthorizationHeader(
    method: string,
    path: string,
    timestamp: string,
    nonceStr: string,
    body: string,
  ) {
    const message = `${method}\n${path}\n${timestamp}\n${nonceStr}\n${body}\n`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(message)
      .sign(this.privateKey, 'base64');

    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${this.merchantSerial}",signature="${signature}"`;
  }

  private formatPrivateKey(key: string) {
    const trimmed = key.replace(/\\n/g, '\n').trim();
    if (trimmed.includes('BEGIN PRIVATE KEY')) {
      return trimmed;
    }
    return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;
  }

  /**
   * 主动查询微信支付结果
   * @param orderId 订单ID
   * @returns
   */
  async queryTrade(orderId: string): Promise<Record<string, any>> {
    if (!orderId) {
      throw new BadRequestException('orderId 不能为空');
    }

    // 根据微信支付文档：https://pay.weixin.qq.com/doc/v3/merchant/4012791879
    // 如果商户只保留了自己的 out_trade_no，则应使用 out-trade-no 查询接口
    const path = `/v3/pay/transactions/out-trade-no/${orderId}?mchid=${this.mchId}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const authorization = this.buildAuthorizationHeader(
      'GET',
      path,
      timestamp,
      nonceStr,
      '',
    );

    try {
      const response = await this.httpClient.get(path, {
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
        },
      });
      return response.data;
    } catch (error) {
      this.logger.error('调用微信支付查询接口失败', error as Error, {
        orderId,
        response: error?.response?.data,
      });
      throw error;
    }
  }
}
