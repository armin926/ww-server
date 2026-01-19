import { Injectable } from '@nestjs/common';
import { PaymentOrderPayload, PaymentInitiationResult } from './payment.types';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';
import { BadRequestException, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { PaymentChannel } from './payment.types';
import {
  PaymentRecord,
  PaymentRecordDocument,
  PaymentRecordStatus,
} from './payment-record.schema';
import { AlipayPaymentService } from './providers/alipay-payment.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  constructor(
    @InjectModel(PaymentRecord.name)
    private readonly paymentRecordModel: Model<PaymentRecordDocument>,
    private readonly alipayPayment: AlipayPaymentService,
  ) {}

  // 进行套餐逻辑验证
  private readonly planAmountMap = {
    custom: {
      type: 'custom',
      validate: (amount: number) =>
        Number.isInteger(amount) && amount >= 1 && amount <= 10000,
    },
    single: { type: 'single', validate: (amount: number) => amount === 18.8 },
    pro: { type: 'pro', validate: (amount: number) => amount === 28.8 },
    max: { type: 'max', validate: (amount: number) => amount === 68.8 },
    ultra: { type: 'ultra', validate: (amount: number) => amount === 128.8 },
  };
  /**
   * 创建支付订单
   * @param dto 支付订单信息
   * @returns 支付订单结果
   */
  async initiatePayment(
    dto: InitiatePaymentDto,
    user?: { userId?: string },
  ): Promise<PaymentInitiationResult> {
    // 进行套餐逻辑验证。
    // 检查是否存在该套餐
    const plan = this.planAmountMap[dto.planId];

    if (!plan) {
      throw new BadRequestException('无效的套餐ID');
    }

    // 验证金额
    if (!plan.validate(dto.amount)) {
      throw new BadRequestException(`${dto.planId} 套餐验证失败`);
    }

    // 创建支付订单 payload
    const payload: PaymentOrderPayload = {
      // 订单ID
      orderId:
        dto.channel === PaymentChannel.ALIPAY
          ? uuid()
          : uuid().replace(/-/g, ''),
      // 订单金额
      amount: dto.amount,
      // 套餐ID
      planId: dto.planId,
      // 套餐名称
      planName: dto.planName,
      // 来源
      source: dto.source,
      // 订单描述
      description: dto.description,
      // 订单货币
      currency: dto.currency ?? 'CNY',
      // 订单元数据
      metadata: dto.metadata,
      // 订单通知URL
      notifyUrl:
        dto.notifyUrl ??
        (dto.channel === PaymentChannel.WECHAT
          ? process.env.WECHAT_PAY_NOTIFY_URL
          : process.env.ALIPAY_NOTIFY_URL),
    };

    payload.metadata = this.buildPaymentMetadata(dto, payload, user?.userId);

    this.logger.log(
      `创建支付订单记录: orderId=${payload.orderId}, channel=${dto.channel}, amount=${payload.amount}, userId=${user?.userId}`,
    );

    // 根据支付渠道创建支付订单
    if (dto.channel === PaymentChannel.ALIPAY) {
      // 支付宝支付
      return this.alipayPayment.initiatePayment(payload);
    }
    // TODO：临时防爆错
    return this.alipayPayment.initiatePayment(payload);

    // 微信支付 - 不再需要内存缓存，元数据已保存到数据库
    // return this.wechatPayment.initiatePayment(payload);
  }

  /**
   * 主动查询支付宝支付结果
   * @param orderId 订单ID
   * @param user 当前用户信息
   * @returns 支付结果
   */
  async queryAlipayPaymentStatus(orderId: string, user: { userId: string }) {}

  /**
   * 主动查询微信支付结果
   * @param orderId 订单ID
   * @param user 当前用户信息
   * @returns 支付结果
   */
  async queryWechatPaymentStatus(orderId: string, user: { userId: string }) {}

  /**
   * 构建支付订单元数据
   * @param dto 支付订单信息
   * @param payload 支付订单payload
   * @returns 支付订单元数据
   */
  private buildPaymentMetadata(
    dto: InitiatePaymentDto,
    payload: PaymentOrderPayload,
    userId?: string,
  ): Record<string, any> {
    const metadata: Record<string, any> = {
      ...(dto.metadata || {}),
      planId: payload.planId,
      planName: payload.planName,
      source: payload.source,
      amount: payload.amount,
      currency: payload.currency,
      description: payload.description,
    };

    if (userId) {
      metadata.userId = userId;
    }

    return metadata;
  }
}
