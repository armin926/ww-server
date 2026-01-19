import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Min,
  IsNumber,
} from 'class-validator';
import { PaymentChannel } from '../payment.types';
import { ApiProperty } from '@nestjs/swagger';

export class InitiatePaymentDto {
  @IsString()
  @IsOptional()
  @ApiProperty({ description: '订单ID', required: false })
  orderId?: string;

  // 支持小数，最小值为0.01
  @IsNumber()
  @Min(0.01)
  @ApiProperty({ description: '订单金额', required: true })
  amount: number;

  @IsIn(['custom', 'single', 'pro', 'max', 'ultra'])
  @ApiProperty({ description: '套餐ID', required: true })
  planId: string;

  @IsString()
  @ApiProperty({ description: '套餐名称', required: true })
  planName: string;

  // 来源，web, h5
  @IsIn(['web', 'h5'])
  @ApiProperty({ description: '来源', required: true })
  source: string;

  @IsString()
  @ApiProperty({ description: '订单描述', required: true })
  description: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: '订单货币', required: false })
  currency?: string;

  @IsEnum(PaymentChannel)
  @ApiProperty({ description: '支付渠道', required: true })
  channel: PaymentChannel;

  @IsOptional()
  @ApiProperty({ description: '订单元数据', required: false })
  metadata?: Record<string, any>;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: '订单通知URL', required: false })
  notifyUrl?: string;
}
