import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { AlipayPaymentService } from './providers/alipay-payment.service';
import { WechatPaymentService } from './providers/wechat-payment.service';
import { PaymentRecord, PaymentRecordSchema } from './payment-record.schema';
import { User, UserSchema } from '../user/schemas/user.schema';
import {
  UserTransaction,
  UserTransactionSchema,
} from '../user/schemas/user-transaction.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: PaymentRecord.name, schema: PaymentRecordSchema },
      { name: User.name, schema: UserSchema },
      {
        name: UserTransaction.name,
        schema: UserTransactionSchema,
      },
    ]),
  ],
  controllers: [PaymentController],
  providers: [PaymentService, AlipayPaymentService, WechatPaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
