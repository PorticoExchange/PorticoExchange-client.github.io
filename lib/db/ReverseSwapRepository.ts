import { Op, WhereOptions } from 'sequelize';
import { SwapUpdateEvent } from '../consts/Enums';
import ReverseSwap, { ReverseSwapType } from './models/ReverseSwap';

class ReverseSwapRepository {
  public getReverseSwaps = (options?: WhereOptions): Promise<ReverseSwap[]> => {
    return ReverseSwap.findAll({
      where: options,
    });
  }

  public getReverseSwapsMempool = (height: number): Promise<ReverseSwap[]> => {
    return ReverseSwap.findAll({
      where: {
        status: {
          [Op.eq]: [
            SwapUpdateEvent.TransactionMempool,
            // Op.or SwapUpdateEvent.TransactionConfirmed,
          ],
        } as any,
        timeoutBlockHeight: {
          [Op.gte]: height,
        },
      },
    });
  }

  public getReverseSwapsConfirmed = (height: number): Promise<ReverseSwap[]> => {
    return ReverseSwap.findAll({
      where: {
        status: {
          [Op.eq]: [
            SwapUpdateEvent.TransactionConfirmed,
          ],
        } as any,
        timeoutBlockHeight: {
          [Op.gte]: height,
        },
      },
    });
  }

  public getReverseSwapsExpirable = (height: number): Promise<ReverseSwap[]> => {
    return ReverseSwap.findAll({
      where: {
        status: {
          [Op.not]: [
            SwapUpdateEvent.SwapExpired,
            SwapUpdateEvent.TransactionFailed,
            SwapUpdateEvent.TransactionRefunded,
            SwapUpdateEvent.InvoiceSettled,
            // some txns get stuck in mempool, expire/cancel them as well but should avoid refunding them because it will just fail.
            SwapUpdateEvent.TransactionMempool,
          ],
        } as any,
        timeoutBlockHeight: {
          [Op.lte]: height,
        },
      },
    });
  }

  public getReverseSwap = (options: WhereOptions): Promise<ReverseSwap | null> => {
    return ReverseSwap.findOne({
      where: options,
    });
  }

  public addReverseSwap = (reverseSwap: ReverseSwapType): Promise<ReverseSwap> => {
    return ReverseSwap.create(reverseSwap);
  }

  public setReverseSwapStatus = (reverseSwap: ReverseSwap, status: string, failureReason?: string): Promise<ReverseSwap> => {
    console.log('reverseswaprepository.41 update: '+ JSON.stringify(reverseSwap), status);
    return reverseSwap.update({
      status,
      failureReason,
    });
  }

  public setLockupTransaction = (reverseSwap: ReverseSwap, transactionId: string, minerFee: number, vout?: number): Promise<ReverseSwap> => {
    console.log('reverseswaprepository.49 setLockupTransaction update');
    return reverseSwap.update({
      minerFee,
      transactionId,
      transactionVout: vout,
      status: SwapUpdateEvent.TransactionMempool,
    });
  }

  public setInvoiceSettled = (reverseSwap: ReverseSwap, preimage: string): Promise<ReverseSwap> => {
    return reverseSwap.update({
      preimage,
      status: SwapUpdateEvent.InvoiceSettled,
    });
  }

  public setTransactionRefunded = (reverseSwap: ReverseSwap, minerFee: number, failureReason: string): Promise<ReverseSwap> => {
    return reverseSwap.update({
      failureReason,
      minerFee: reverseSwap.minerFee + minerFee,
      status: SwapUpdateEvent.TransactionRefunded,
    });
  }

  public setReverseSwapRawTx = (reverseSwap: ReverseSwap, rawTx: string): Promise<ReverseSwap> => {
    console.log('reverseswaprepository.107 update: '+ JSON.stringify(reverseSwap), rawTx);
    return reverseSwap.update({
      rawTx,
    });
  }

  public dropTable = (): Promise<void> => {
    return ReverseSwap.drop();
  }
}

export default ReverseSwapRepository;
