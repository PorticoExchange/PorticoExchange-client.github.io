import fs from 'fs';
import { providers } from 'ethers';
// import { connectWebSocketClient } from '@stacks/blockchain-api-client';
import * as ecc from 'tiny-secp256k1';
import { Network } from 'bitcoinjs-lib';
import BIP32Factory, { BIP32Interface } from 'bip32';
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import Errors from './Errors';
import Wallet from './Wallet';
import Logger from '../Logger';
import { splitDerivationPath } from '../Utils';
import ChainClient from '../chain/ChainClient';
import BaseClient from '../BaseClient';
import LndClient from '../lightning/LndClient';
import { CurrencyType } from '../consts/Enums';
import KeyRepository from '../db/KeyRepository';
import EthereumManager from './ethereum/EthereumManager';
import RskManager from './rsk/RskManager';
import StacksManager from './stacks/StacksManager';
import ChainTipRepository from '../db/ChainTipRepository';
import { KeyProviderType } from '../db/models/KeyProvider';
import LndWalletProvider from './providers/LndWalletProvider';
import CoreWalletProvider from './providers/CoreWalletProvider';
import WalletProviderInterface from './providers/WalletProviderInterface';
// import { stringify } from '@iarna/toml';

type CurrencyLimits = {
  maxSwapAmount: number;
  minSwapAmount: number;

  minWalletBalance: number;

  minLocalBalance?: number;
  minRemoteBalance?: number;

  maxZeroConfAmount?: number;
};

type Currency = {
  symbol: string;
  type: CurrencyType,
  limits: CurrencyLimits;

  // Needed for UTXO based coins
  network?: Network;
  lndClient?: LndClient;
  chainClient?: ChainClient;

  // Needed for Ether and tokens on Ethereum
  provider?: providers.Provider;

  // Needed for Stacks
  stacksClient?: BaseClient;
};

const bip32 = BIP32Factory(ecc);
/**
 * WalletManager creates wallets instances that generate keys derived from the seed and
 * interact with the wallet of LND to send and receive onchain coins
 */
class WalletManager {
  public wallets = new Map<string, Wallet>();

  public ethereumManager?: EthereumManager;
  public rskManager?: RskManager;
  public stacksManager?: StacksManager;
  public liquidManager?: LiquidManager;

  private readonly mnemonic: string;
  private readonly masterNode: BIP32Interface;
  private readonly keyRepository: KeyRepository;

  private readonly derivationPath = 'm/0';

  constructor(private logger: Logger, mnemonicPath: string, private currencies: Currency[], ethereumManager?: EthereumManager, rskManager?: RskManager, stacksManager?: StacksManager, liquidManger?: LiquidManager) {
    this.mnemonic = this.loadMnemonic(mnemonicPath);
    this.masterNode = bip32.fromSeed(mnemonicToSeedSync(this.mnemonic));

    this.keyRepository = new KeyRepository();

    this.ethereumManager = ethereumManager;
    this.rskManager = rskManager;
    this.stacksManager = stacksManager;
    this.liquidMangaer = liquidManager;
    
  }

  /**
   * Initializes a new WalletManager with a mnemonic
   */
  public static fromMnemonic = (logger: Logger, mnemonic: string, mnemonicPath: string, currencies: Currency[], ethereumManager?: EthereumManager, rskManager?: RskManager, stacksManager?: StacksManager, liquidManger?: LiquidManager): WalletManager => {
    if (!validateMnemonic(mnemonic)) {
      throw(Errors.INVALID_MNEMONIC(mnemonic));
    }

    fs.writeFileSync(mnemonicPath, mnemonic);

    return new WalletManager(logger, mnemonicPath, currencies, ethereumManager, rskManager, stacksManager);
  }

  public init = async (chainTipRepository: ChainTipRepository): Promise<void> => {
    const keyProviderMap = await this.getKeyProviderMap();

    for (const currency of this.currencies) {
      if (currency.type !== CurrencyType.BitcoinLike) {
        continue;
      }

      let walletProvider: WalletProviderInterface | undefined = undefined;

      // The LND client is also used as onchain wallet for UTXO based chains if available
      if (currency.lndClient !== undefined) {
        walletProvider = new LndWalletProvider(this.logger, currency.lndClient, currency.chainClient!);

      // Else the Bitcoin Core wallet is used
      } else {
        walletProvider = new CoreWalletProvider(this.logger, currency.chainClient!);

        // Sanity check that wallet support is compiled in
        try {
          await walletProvider.getBalance();
        } catch (error) {
          // No wallet support is compiled in
          if (error.message === 'Method not found') {
            throw Errors.NO_WALLET_SUPPORT(currency.symbol);
          } else {
            throw error;
          }
        }
      }

      let keyProviderInfo = keyProviderMap.get(currency.symbol);

      // Generate a new KeyProvider if that currency does not have one yet
      if (!keyProviderInfo) {
        keyProviderInfo = {
          highestUsedIndex: 0,
          symbol: currency.symbol,
          derivationPath: `${this.derivationPath}/${this.getHighestDepthIndex(keyProviderMap, 2) + 1}`,
        };

        keyProviderMap.set(currency.symbol, keyProviderInfo);

        await this.keyRepository.addKeyProvider({
          ...keyProviderInfo,
          symbol: currency.symbol,
        });
      }

      const wallet = new Wallet(
        this.logger,
        CurrencyType.BitcoinLike,
        walletProvider,
      );

      wallet.initKeyProvider(
        currency.network!,
        keyProviderInfo.derivationPath,
        keyProviderInfo.highestUsedIndex,
        this.masterNode,
        this.keyRepository,
      );

      this.wallets.set(currency.symbol, wallet);
    }

    if (this.ethereumManager) {
      // this.logger.error("inited ethereumManager inside WalletManager");
      const ethereumWallets = await this.ethereumManager.init(this.mnemonic, chainTipRepository);

      for (const [symbol, ethereumWallet] of ethereumWallets) {
        this.wallets.set(symbol, ethereumWallet);
      }
    }

    if (this.rskManager) {
      // this.logger.error("inited rskManager inside WalletManager");
      const rskWallets = await this.rskManager.init(this.mnemonic, chainTipRepository);

      for (const [symbol, rskWallet] of rskWallets) {
        this.wallets.set(symbol, rskWallet);
      }
    }

    if (this.stacksManager) {
      // this.logger.error("walletmanager.179 init stacksManager inside WalletManager");
      // this.mnemonic, chainTipRepository
      const stacksWallets = await this.stacksManager.init(this.mnemonic, chainTipRepository);

      for (const [symbol, stacksWallet] of stacksWallets) {
        // this.logger.verbose("walletmanager.185 wallets.set " + stacksWallet);
        this.wallets.set(symbol, stacksWallet);
      }
    }

  }

  private loadMnemonic = (filename: string) => {
    if (fs.existsSync(filename)) {
      return fs.readFileSync(filename, 'utf-8').trim();
    }

    throw(Errors.NOT_INITIALIZED());
  }

  private getKeyProviderMap = async () => {
    const map = new Map<string, KeyProviderType>();
    const keyProviders = await this.keyRepository.getKeyProviders();

    keyProviders.forEach((keyProvider) => {
      map.set(keyProvider.symbol, {
        symbol: keyProvider.symbol,
        derivationPath: keyProvider.derivationPath,
        highestUsedIndex: keyProvider.highestUsedIndex,
      });
    });

    return map;
  }

  private getHighestDepthIndex = (map: Map<string, KeyProviderType>, depth: number): number => {
    if (depth === 0) {
      throw(Errors.INVALID_DEPTH_INDEX(depth));
    }

    let highestIndex = -1;

    map.forEach((info) => {
      const split = splitDerivationPath(info.derivationPath);
      const index = split.sub[depth - 1];

      if (index > highestIndex) {
        highestIndex = index;
      }
    });

    return highestIndex;
  }
}

export default WalletManager;
export { Currency };
