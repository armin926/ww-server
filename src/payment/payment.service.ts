import { Injectable } from '@nestjs/common';
import { PaymentOrderPayload, PaymentInitiationResult } from './payment.types';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { PaymentChannel } from './payment.types';
import {
  PaymentRecord,
  PaymentRecordDocument,
  PaymentRecordStatus,
} from './payment-record.schema';
import { User, UserDocument } from '../user/schemas/user.schema';
import {
  UserTransaction,
  UserTransactionDocument,
  UserTransactionType,
} from '../user/schemas/user-transaction.schema';

import { AlipayPaymentService } from './providers/alipay-payment.service';
import { WechatPaymentService } from './providers/wechat-payment.service';

import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

/**
 * 支付记录上下文类型定义
 *
 * 该类型用于描述一次支付交易在系统中的完整上下文信息，
 * 通常用于：支付回调处理、支付记录入库、对账、风控与审计场景。
 */
export type PaymentRecordContext = {
  /** 业务系统中的用户唯一标识 */
  userId: string;

  /** 买家登录账号（支付宝侧返回的脱敏账号，如手机号或邮箱） */
  buyerLogonId: string;

  /** 买家实际支付金额 */
  buyerPayAmount: string;

  /** 可开票金额 */
  invoiceAmount: string;

  /** 商户系统生成的订单号（商户侧唯一） */
  outTradeNo: string;

  /**
   * 透传参数（passback_params）
   * - 支付发起时由商户传入
   * - 支付完成后由支付宝原样回传
   * - 通常是 URL 编码后的 JSON 字符串
   */
  passbackParams: string;

  /** 使用积分抵扣的金额 */
  pointAmount: string;

  /** 实际到账金额（扣除手续费后的金额） */
  receiptAmount: string;

  /** 订单总金额 */
  totalAmount: string;

  /** 支付宝侧生成的交易号（平台侧唯一） */
  tradeNo: string;

  /**
   * 交易状态
   * - WAIT_BUYER_PAY：等待买家支付
   * - TRADE_SUCCESS：支付成功
   * - TRADE_FAIL：支付失败
   * - 其他字符串：兼容支付宝未来可能新增的状态
   */
  tradeStatus: 'WAIT_BUYER_PAY' | 'TRADE_SUCCESS' | 'TRADE_FAIL' | string;

  /** 买家在当前应用下的 OpenId（小程序 / 公众号场景常见） */
  buyerOpenId: string;

  /** 链路追踪 ID，用于分布式系统日志与问题定位 */
  traceId: string;

  /**
   * 解析后的业务元数据
   * - 通常由 passbackParams 反序列化得到
   * - 存放业务自定义字段，如 planId、source、场景标识等
   */
  metadata?: Record<string, any>;

  /** 支付渠道标识，如：alipay / wechat / stripe 等 */
  channel: string;

  /** 实际支付完成时间 */
  paidAt: Date;

  /** 币种，如：CNY / USD */
  currency: string;
};

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  constructor(
    @InjectModel(PaymentRecord.name)
    private readonly paymentRecordModel: Model<PaymentRecordDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(UserTransaction.name)
    private readonly userTransactionModel: Model<UserTransactionDocument>,
    private readonly alipayPayment: AlipayPaymentService,
    private readonly wechatPayment: WechatPaymentService,
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

    // 创建支付记录，保存元数据到数据库（解决微信元数据缓存问题）
    await this.paymentRecordModel.create({
      orderId: payload.orderId,
      userId: user?.userId,
      user: user?.userId ? new Types.ObjectId(user.userId) : undefined,
      channel: dto.channel,
      amount: payload.amount,
      currency: payload.currency,
      planId: payload.planId,
      planName: payload.planName,
      source: payload.source,
      description: payload.description,
      status: PaymentRecordStatus.PENDING,
      metadata: payload.metadata,
      createdAt: new Date().toISOString(),
    });

    this.logger.log(
      `创建支付订单记录: orderId=${payload.orderId}, channel=${dto.channel}, amount=${payload.amount}, userId=${user?.userId}`,
    );

    // 根据支付渠道创建支付订单
    if (dto.channel === PaymentChannel.ALIPAY) {
      // 支付宝支付
      return this.alipayPayment.initiatePayment(payload);
    }

    // 微信支付 - 不再需要内存缓存，元数据已保存到数据库
    return this.wechatPayment.initiatePayment(payload);
  }

  /**
   * 主动查询支付宝支付结果
   * @param orderId 订单ID
   * @param user 当前用户信息
   * @returns 支付结果
   */
  async queryAlipayPaymentStatus(orderId: string, user: { userId: string }) {
    // 先从数据库获取订单信息（包含元数据）
    const paymentRecord = await this.paymentRecordModel
      .findOne({ orderId })
      .exec();

    if (!paymentRecord) {
      throw new BadRequestException('订单不存在');
    }

    // 验证订单归属（安全修复：防止用户 A 查询用户 B 的订单）
    if (paymentRecord.userId && paymentRecord.userId !== user.userId) {
      throw new ForbiddenException('无权查询此订单');
    }

    // 如果订单已成功，直接返回
    if (paymentRecord.status === PaymentRecordStatus.SUCCESS) {
      this.logger.debug(`订单 ${orderId} 已支付成功，直接返回`);
      return { orderId, success: true };
    }

    // 获取支付宝查询结果
    const response = await this.alipayPayment.queryTrade(orderId);

    // 判断支付是否成功
    const success = response.tradeStatus === 'TRADE_SUCCESS';
    this.logger.log(
      `支付宝支付订单查询结果: orderId=${orderId}, status=${response.tradeStatus}`,
    );

    if (success) {
      // 使用数据库中的元数据，支付宝的 passback_params 作为备份
      const metadata = this.extractAlipayMetadata(
        response,
        paymentRecord.metadata,
      );
      response.metadata = metadata;

      await this.finalizePaymentSuccess({
        ...(response as PaymentRecordContext),
        userId: user.userId,
        channel: PaymentChannel.ALIPAY,
        paidAt: response.sendPayDate,
        currency: 'CNY',
      });
    }

    return {
      orderId,
      success,
    };
  }

  /**
   * 主动查询微信支付结果
   * @param orderId 订单ID
   * @param user 当前用户信息
   * @returns 支付结果
   */
  async queryWechatPaymentStatus(orderId: string, user: { userId: string }) {
    // 先从数据库获取订单信息（包含元数据）
    const paymentRecord = await this.paymentRecordModel
      .findOne({ orderId })
      .exec();

    if (!paymentRecord) {
      throw new BadRequestException('订单不存在');
    }

    // 验证订单归属（安全修复：防止用户 A 查询用户 B 的订单）
    if (paymentRecord.userId && paymentRecord.userId !== user.userId) {
      throw new ForbiddenException('无权查询此订单');
    }

    // 如果订单已成功，直接返回
    if (paymentRecord.status === PaymentRecordStatus.SUCCESS) {
      this.logger.debug(`订单 ${orderId} 已支付成功，直接返回`);
      return { orderId, success: true };
    }

    // 获取微信支付查询结果
    const response = await this.wechatPayment.queryTrade(orderId);
    this.logger.log(
      `微信支付订单查询结果: orderId=${orderId}, state=${response.trade_state}`,
    );

    // 判断微信支付，是否支付成功
    const success = response.trade_state === 'SUCCESS';
    if (success) {
      // 使用数据库中的元数据（方案三）
      response.metadata = paymentRecord.metadata;

      // 完成支付成功
      await this.finalizePaymentSuccess({
        ...(response as PaymentRecordContext),
        userId: user.userId,
        channel: PaymentChannel.WECHAT,
        paidAt: response.success_time,
        currency: 'CNY',
        outTradeNo: response.out_trade_no,
        buyerPayAmount: (response.amount.payer_total / 100).toString(),
      });
    }
    return {
      orderId,
      success,
    };
  }

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

  /**
   * 从支付宝返回结果中提取业务自定义的元数据（passback_params）
   *
   * @param response  支付宝接口返回的原始响应对象
   * @param fallback  当无法从 response 中解析到元数据时使用的兜底数据
   * @returns         解析后的元数据对象；如果不存在则返回 undefined
   */
  private extractAlipayMetadata(
    response: Record<string, any>,
    fallback?: Record<string, any>,
  ): Record<string, any> | undefined {
    // 支付宝不同接口或不同 SDK 版本中，
    // 透传参数字段命名可能不一致，这里做多种字段名的兼容处理
    const passback =
      response.passback_params || // 标准字段名（常见于接口返回）
      response.passbackParams || // 驼峰写法（部分 SDK 自动转换）
      response.passbackparams; // 全小写写法（极端兼容场景）

    // 将透传参数交给统一的解析方法处理，
    // 如果 passback 为空，则使用 fallback 作为兜底
    return this.parseMetadata(passback, fallback);
  }

  /**
   * 解析支付宝回传的 passback 元数据，统一转换为对象结构
   *
   * @param value     原始元数据，可能是字符串（URL 编码的 JSON）或对象
   * @param fallback  当解析失败或不存在时使用的兜底数据
   * @returns         解析成功后的对象；若失败则返回 fallback 或 undefined
   */
  private parseMetadata(
    value?: string | Record<string, any>,
    fallback?: Record<string, any>,
  ): Record<string, any> | undefined {
    // 如果没有传入任何值，直接返回兜底数据
    if (!value) {
      return fallback;
    }

    // 如果已经是对象类型，说明上游已解析完成，直接返回
    if (typeof value === 'object') {
      return value;
    }

    try {
      // 支付宝 passback_params 通常是经过 URL 编码的字符串，需要先解码
      const decoded = decodeURIComponent(value);

      // 解码后应为 JSON 字符串，尝试反序列化为对象
      return JSON.parse(decoded);
    } catch (error) {
      // 解码或 JSON 解析失败时，记录告警日志，便于排查异常数据
      this.logger.warn(
        `解析支付 passback 元数据失败: ${value}`,
        error as Error,
      );

      // 解析失败时返回兜底数据，保证业务流程不中断
      return fallback;
    }
  }

  /**
   * 完成支付成功
   * @param context 支付记录上下文
   * @returns
   */
  private async finalizePaymentSuccess(context: PaymentRecordContext) {
    // 🔒 安全修复：使用原子操作更新订单状态为 PROCESSING，防止并发重复发货
    const updatedRecord = await this.paymentRecordModel
      .findOneAndUpdate(
        {
          orderId: context.outTradeNo,
          status: { $in: [PaymentRecordStatus.PENDING] }, // 只有 PENDING 状态才能更新
        },
        {
          $set: {
            status: PaymentRecordStatus.PROCESSING,
            processingAt: new Date(),
            notificationPayload: context,
          },
        },
        { new: true },
      )
      .exec();

    // 如果更新失败，说明订单已被处理或不存在
    if (!updatedRecord) {
      const existingRecord = await this.paymentRecordModel
        .findOne({ orderId: context.outTradeNo })
        .exec();

      if (existingRecord?.status === PaymentRecordStatus.SUCCESS) {
        this.logger.debug(
          `订单 ${context.outTradeNo} 已处理成功，跳过重复的支付通知`,
        );
        return;
      }

      if (existingRecord?.status === PaymentRecordStatus.PROCESSING) {
        this.logger.warn(
          `订单 ${context.outTradeNo} 正在处理中，可能存在并发请求`,
        );
        return;
      }

      this.logger.error(
        `订单 ${context.outTradeNo} 状态异常，无法处理支付成功`,
      );
      return;
    }

    try {
      // 🔒 安全修复：验证支付金额是否匹配套餐
      this.validatePaymentAmount(context);

      // 应用套餐权益
      await this.applyPlanBenefits(context);

      // 确保充值流水
      await this.ensureRechargeTransaction(context);

      // 🔒 最终更新订单状态为 SUCCESS
      await this.paymentRecordModel
        .findByIdAndUpdate(updatedRecord._id, {
          $set: {
            status: PaymentRecordStatus.SUCCESS,
            paidAt: context.paidAt,
          },
        })
        .exec();

      this.logger.log(
        `订单 ${context.outTradeNo} 支付成功处理完成: userId=${context.userId}, amount=${context.buyerPayAmount}, planId=${context.metadata?.planId}`,
      );
    } catch (error) {
      // 如果处理失败，回滚订单状态为 PENDING，允许重试
      await this.paymentRecordModel
        .findByIdAndUpdate(updatedRecord._id, {
          $set: { status: PaymentRecordStatus.PENDING },
        })
        .exec();

      this.logger.error(
        `订单 ${context.outTradeNo} 处理失败，已回滚状态: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 🔒 安全修复：验证支付金额是否匹配套餐
   * @param context 支付记录上下文
   */
  private validatePaymentAmount(context: PaymentRecordContext) {
    const planId = context.metadata?.planId;
    if (!planId) {
      this.logger.warn(`订单 ${context.outTradeNo} 缺少套餐信息，跳过金额验证`);
      return;
    }

    const plan = this.planAmountMap[planId];
    if (!plan) {
      throw new BadRequestException(`无效的套餐ID: ${planId}`);
    }

    const actualAmount = this.normalizeAmount(context.buyerPayAmount);
    const expectedAmount = this.normalizeAmount(context.metadata?.amount);

    // 对于 custom 套餐，只需要验证金额范围
    if (planId === 'custom') {
      if (!plan.validate(actualAmount)) {
        throw new BadRequestException(
          `自定义套餐金额 ${actualAmount} 不在允许范围内 (1-10000)`,
        );
      }
      return;
    }

    // TODO：测试暂时注释一下代码
    // 对于固定金额套餐，验证实付金额是否匹配（允许 0.01 的浮点误差）
    if (Math.abs(actualAmount - expectedAmount) > 0.01) {
      throw new BadRequestException(
        `支付金额不匹配: 实付=${actualAmount}, 应付=${expectedAmount}, 套餐=${planId}`,
      );
    }

    // 进一步验证套餐的金额规则
    if (!plan.validate(expectedAmount)) {
      throw new BadRequestException(
        `套餐 ${planId} 的金额 ${expectedAmount} 验证失败`,
      );
    }

    this.logger.debug(
      `订单 ${context.outTradeNo} 金额验证通过: planId=${planId}, amount=${actualAmount}`,
    );
  }

  /**
   * 标准化金额
   * @param primary 主金额
   * @param fallback 备用金额
   * @returns
   */
  private normalizeAmount(
    primary?: string | number,
    fallback?: number,
  ): number {
    if (typeof primary === 'number') {
      return primary;
    }

    if (typeof primary === 'string') {
      const parsed = Number(primary);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }

    return fallback ?? 0;
  }

  /**
   * 应用套餐权益
   * @param record 支付记录
   * @param paidAmount 支付金额
   * @returns 应用套餐权益结果
   */
  private async applyPlanBenefits(context: PaymentRecordContext) {
    // 获取套餐ID
    const planId = context.metadata?.planId;
    if (!planId) {
      this.logger.warn(`订单 ${context.outTradeNo} 缺少套餐信息，无法更新权益`);
      return;
    }

    if (!context.userId) {
      this.logger.warn(`订单 ${context.outTradeNo} 缺少用户信息，无法更新权益`);
      return;
    }

    // 计算增量
    const increments: Record<string, number> = {};

    // 根据套餐ID更新用户权益
    switch (planId) {
      case 'custom':
        // TODO：这里增加的旺旺币为实付金额，后续看是否需要根据套餐金额进行调整
        const effectiveAmount = this.normalizeAmount(context.buyerPayAmount);
        if (effectiveAmount > 0) {
          increments.wwCoinBalance = effectiveAmount;
        }
        break;
      case 'single':
        increments.specialRemainingCount = 1;
        break;
      case 'pro':
        increments.resumeRemainingCount = 1;
        increments.specialRemainingCount = 1;
        increments.behaviorRemainingCount = 1;
        break;
      case 'max':
        increments.resumeRemainingCount = 3;
        increments.specialRemainingCount = 3;
        increments.behaviorRemainingCount = 3;
        break;
      case 'ultra':
        increments.resumeRemainingCount = 6;
        increments.specialRemainingCount = 16;
        increments.behaviorRemainingCount = 8;
        break;
      default:
        this.logger.warn(`未知套餐 ${planId}，跳过权益更新`);
        return;
    }

    // 🔒 传递订单号以确保幂等性
    await this.incrementUserBenefits(
      context.userId,
      increments,
      context.outTradeNo,
    );
  }

  /**
   * 增量更新用户权益（幂等操作）
   * @param userId 用户ID
   * @param increments 增量
   * @param orderId 订单号（用于幂等性保证）
   * @returns 增量更新用户权益结果
   */
  private async incrementUserBenefits(
    userId: string,
    increments: Record<string, number>,
    orderId: string,
  ) {
    // 过滤出有效增量
    const entries = Object.entries(increments).filter(
      ([, value]) => typeof value === 'number' && value !== 0,
    );

    if (!entries.length) {
      return;
    }

    if (!Types.ObjectId.isValid(userId)) {
      this.logger.warn(`用户ID ${userId} 非法，无法更新套餐权益`);
      return;
    }

    // 计算增量
    const inc = entries.reduce(
      (acc, [key, value]) => {
        acc[key] = value;
        return acc;
      },
      {} as Record<string, number>,
    );

    // 🔒 幂等性保证：使用订单号作为唯一标识
    // 只有当用户的 processedOrders 中不包含当前订单号时才执行更新
    const updatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: userId,
          processedOrders: { $ne: orderId }, // 订单未处理过
        },
        {
          $inc: inc, // 增加权益
          $push: { processedOrders: orderId }, // 记录已处理的订单
        },
        { new: false },
      )
      .exec();

    if (!updatedUser) {
      // 检查是订单已处理还是用户不存在
      const user = await this.userModel.findById(userId).exec();
      if (!user) {
        this.logger.warn(`未找到用户 ${userId}，权益更新失败`);
      } else {
        this.logger.warn(
          `订单 ${orderId} 已为用户 ${userId} 发放过权益，跳过重复处理`,
        );
      }
    } else {
      this.logger.log(
        `成功为用户 ${userId} 发放订单 ${orderId} 的权益: ${JSON.stringify(inc)}`,
      );
    }
  }

  /**
   * 确保充值流水
   * @param context 支付记录
   * @returns 确保充值流水结果
   */
  private async ensureRechargeTransaction(context: PaymentRecordContext) {
    if (!(this.normalizeAmount(context.buyerPayAmount) > 0)) {
      this.logger.warn(
        `订单 ${context.outTradeNo} 支付金额为0，跳过充值流水记录`,
      );
      return;
    }

    // 获取用户ID
    const preferredIdentifier = context.userId;

    // 如果用户标识为空，则跳过充值流水记录
    if (!preferredIdentifier) {
      this.logger.warn(
        `订单 ${context.outTradeNo} 缺少用户标识，无法记录充值流水`,
      );
      return;
    }

    const update: Partial<UserTransaction> = {
      userIdentifier: preferredIdentifier,
      type: UserTransactionType.RECHARGE,
      amount: this.normalizeAmount(context.buyerPayAmount),
      currency: context.currency || 'CNY',
      description:
        context.metadata?.description ||
        `充值${context.metadata?.planName ? `-${context.metadata?.planName}` : ''}`,
      planId: context.metadata?.planId,
      planName: context.metadata?.planName,
      source: context.metadata?.source,
      relatedOrderId: context.outTradeNo,
      metadata: context.metadata,
      payData: context,
    };

    update.user = new Types.ObjectId(context.userId);

    // 持久化充值流水
    await this.userTransactionModel
      .findOneAndUpdate(
        { relatedOrderId: context.outTradeNo },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }
}
