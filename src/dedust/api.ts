import { Factory, JettonWallet, MAINNET_FACTORY_ADDR, VaultJetton } from '@dedust/sdk';
import { Address, TonClient4, Sender, WalletContractV3R2, WalletContractV4 } from '@ton/ton';
import { Cell, OpenedContract, beginCell, ContractProvider, internal,  toNano } from '@ton/core';
import { Asset, PoolType, ReadinessStatus, JettonRoot } from '@dedust/sdk';
import axios from 'axios';
import { mnemonicToPrivateKey, mnemonicToWalletKey } from '@ton/crypto';
import {fetchDataGet} from '../utils'
import { Pool, createPool, deletePoolsCollection, } from '../ton-connect/mongo';

const tonClient = new TonClient4({ endpoint: 'https://mainnet-v4.tonhubapi.com' });
const factory = tonClient.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));

export interface Jetton{
    type: string,
    address: string,
    name: string,
    symbol: string,
    image: string,
    decimals: number,
    riskScore: string,
}

export interface walletAsset{
    address: string,
    asset:{
        type: string,
        address: string
    },
    balance: bigint
}

export interface PriceResult{
    pool:{
        address: string,
        isStable: false,
        assets: string[],
        reserves: string[],
    },
    amountIn: bigint,
    amountOut: bigint,
    tradeFee: bigint,
    assetIn: string,
    assetOut: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function ton_to_Jetton(sender: Sender, jettonAddress: Address, amountIn: bigint) {
    const tonVault = tonClient.open(await factory.getNativeVault());

    const TON = Asset.native();
    const jetton = Asset.jetton(jettonAddress);

    const pool = tonClient.open(await factory.getPool(PoolType.VOLATILE, [TON, jetton]));

    if ((await pool.getReadinessStatus()) !== ReadinessStatus.READY) {
        throw new Error('Pool (TON, jetton) does not exist.');
    }
    console.log(pool,amountIn,jettonAddress);
    await tonVault.sendSwap(sender, {
        poolAddress: pool.address,
        amount: (amountIn),
        gasAmount: toNano(0.25)
    });
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function jetton_to_Ton(
    sender: Sender,
    userAddress: Address,
    jettonAddress: Address,
    jettonAmount: bigint
) {
    const jettonRoot = tonClient.open(JettonRoot.createFromAddress(jettonAddress));
    let jettonWallet: OpenedContract<JettonWallet>;
    if (userAddress) jettonWallet = tonClient.open(await jettonRoot.getWallet(userAddress));
    else {
        console.log('cannot find wallet!!!', sender);
        return;
    }
    const jettonVault: VaultJetton = tonClient.open(await factory.getJettonVault(jettonAddress));

    const TON = Asset.native();
    const jetton = Asset.jetton(jettonAddress);
    const pool = tonClient.open(await factory.getPool(PoolType.VOLATILE, [jetton, TON]));

    if ((await pool.getReadinessStatus()) !== ReadinessStatus.READY) {
        throw new Error("Pool (TON, SCALE) does not exist.");
    }
    console.log(pool);
    const result = await jettonWallet.sendTransfer(sender, toNano(0.3), {
        amount: (jettonAmount),
        destination: jettonVault.address,
        responseAddress: userAddress, // return gas to user
        forwardAmount: toNano(0.25),
        forwardPayload: VaultJetton.createSwapPayload({ poolAddress: pool.address })
    });
    console.log(result);
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function jetton_to_Jetton(
    sender: Sender,
    userAddress: Address,
    jettonAddress_A: Address,
    jettonAddress_B: Address,
    fromAmount: bigint
) {
    const jetton_A = Asset.jetton(jettonAddress_A);
    const TON = Asset.native();
    const jetton_B = Asset.jetton(jettonAddress_B);

    const TON_JETTON_A = tonClient.open(await factory.getPool(PoolType.VOLATILE, [TON, jetton_A]));
    const TON_JETTON_B = tonClient.open(await factory.getPool(PoolType.VOLATILE, [TON, jetton_B]));
    console.log(TON_JETTON_A, TON_JETTON_B);
    const jettonVault_A: VaultJetton = tonClient.open(
        await factory.getJettonVault(jettonAddress_A)
    );
    const jettonRoot = tonClient.open(JettonRoot.createFromAddress(jettonAddress_A));
    const jettonWallet = tonClient.open(await jettonRoot.getWallet(userAddress));

    await jettonWallet.sendTransfer(
        sender,
        toNano(0.3), // 0.6% TON
        {
            amount: (fromAmount),
            destination: jettonVault_A.address,
            responseAddress: userAddress, // return gas to user
            forwardAmount: toNano(0.25), // 0.5% TON
            forwardPayload: VaultJetton.createSwapPayload({
                poolAddress: TON_JETTON_A.address, // first step: A -> TON
                next: {
                    poolAddress: TON_JETTON_B.address // next step: TON -> B
                }
            })
        }
    );
}


export async function sendTon(
    mnemonics: string[],
    tonAmount:bigint,
    targetAddress: string
) {
      let keyPair = await mnemonicToPrivateKey(mnemonics);
      
      // Create wallet contract
      let workchain = 0; // Usually you need a workchain 0
      let wallet = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });
      let contract = tonClient.open(wallet);
      
      // Create a transfer
      let seqno: number = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [internal({
          value: tonAmount,
          to: targetAddress,
          body: '',
        })]
      });
}

export async function sendJetton(
    mnemonic:string,
    senderAddress:Address,
    jettonAddress:Address,
    amount:bigint,
    targetAddress: Address
) {
    const keyPair = await mnemonicToWalletKey(mnemonic.split(','));

    const wallet = tonClient.open(
        WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey
        })
    );
    let sender = await wallet.sender(keyPair.secretKey);

    const jettonRoot = tonClient.open(JettonRoot.createFromAddress(jettonAddress));
    let jettonWallet: OpenedContract<JettonWallet>;
    jettonWallet = tonClient.open(await jettonRoot.getWallet(senderAddress));
    // Create wallet contract
    
    
    const forwardPayload = beginCell()
        .storeUint(0, 32) // 0 opcode means we have a comment
        .storeStringTail('Hello, TON!')
        .endCell();

    const messageBody = beginCell()
        .storeUint(0x0f8a7ea5, 32) // opcode for jetton transfer
        .storeUint(0, 64) // query id
        .storeCoins(amount) // jetton amount, amount * 10^9
        .storeAddress(targetAddress)
        .storeAddress(targetAddress) // response destination
        .storeBit(0) // no custom payload
        .storeCoins(toNano('0.02')) // forward amount - if >0, will send notification message
        .storeBit(1) // we store forwardPayload as a reference
        .storeRef(forwardPayload)
        .endCell();

   
    const provider = tonClient.provider(jettonWallet.address);
    provider.internal(sender,{
        value: toNano(0.1),
        bounce:true,
        body: messageBody
    })
    
}



export async function fetchPrice(amount: number, from: string, to: string, dex: string){ //////TODO: get price when using ston.fi
    if(from == to) return amount;

    if(dex == 'dedust'){
        //console.log(from,to)
        //console.log({ amount, from, to });
        if(from != 'native')
        if(from.indexOf('jetton:') + 1)
            from = 'jetton:' + Address.parse(from.replace('jetton:','')).toRawString();
        if(to != 'native')
        if(to.indexOf('jetton:') + 1)
            to = 'jetton:' + Address.parse(to.replace('jetton:','')).toRawString();
        const res = (await axios.post('https://api.dedust.io/v2/routing/plan', { amount, from, to },{timeout:10000})).data;
        return res[0][res[0].length - 1].amountOut ;
    }else if(dex == 'ston'){
        const res = (await axios.post(`https://api.ston.fi/v1/swap/simulate?offer_address=${from}&ask_address=${to}&units=${amount}&slippage_tolerance=${0.01}`,{timeout:10000})).data;
        return Number(res['ask_units']);
    }
} 
function checkHaveTrendingCoin(pool: Pool){
    if ( //maintain only trending currencies
        pool.assets[0] == 'native' //||
        //pool.assets[0] == 'jetton:EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA' || //jUSDT
        //pool.assets[0] == 'jetton:EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE' || //SCALE
        //pool.assets[0] == 'jetton:EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728' //jUSDC
    ) return 0; 
    else if (
        pool.assets[1] == 'native' //||
        // pool.assets[1] == 'jetton:EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA' || //jUSDT
        // pool.assets[1] == 'jetton:EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE' || //SCALE
        // pool.assets[1] == 'jetton:EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728' //jUSDC
    ) return 1;
    else return -1;
}
export async function getDedustPair() {
    let counter = 0;
    //fetch data
    const assets: Jetton[] = await fetchDataGet('/assets', 'dedust');
    const extPrice: {symbol:string, price: number}[] = await fetchDataGet('/prices', 'dedust');
    //TON price
    const nativePrice = extPrice.find(p => p.symbol === 'USDT')?.price || 0;
    let pools: Pool[] = await fetchDataGet('/pools-lite', 'dedust');
    pools = pools.filter(pool => checkHaveTrendingCoin(pool) >= 0 && pool!.reserves![0]! > toNano(100));
    
    await Promise.all(pools.map(async (pool, index) => {
        pool.caption = ['', ''];
        pool.prices = [0, 0];
        pool.TVL = 0;
        pool.decimals = [0,0];
        pool.dex = 'dedust'
        let flag = true;
        for (let i = 0; i < 2; i++) {
            try {
                const filteredAssets = assets.filter(asset => asset.address === pool.assets[i]?.replace('jetton:', ''));
                let decimals = 0;
                if (filteredAssets.length !== 0 || pool.assets[i] === 'native') {
                    if (pool.assets[i] === 'native'){ pool.caption[i] = 'TON'; decimals = 9}
                    else { pool.caption[i] = filteredAssets[0]!.symbol; decimals = filteredAssets[0]?.decimals!} //init caption
                    // const pricePost = await fetchPrice(10 ** decimals * 1000000,  pool.assets[i]!, 'jetton:EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA' );
                    
                     pool.decimals[i] = decimals;
                    // const price = pricePost * nativePrice / 10 ** 6 /1000000;
                    // pool.prices[i] = Number(price < 1? price.toPrecision(9):price)  // price in USD
                    // if(pool.assets[i] == 'jetton:EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA')
                    // pool.prices[i] = nativePrice;
                pool.TVL += (pool.prices[i]! * pool.reserves[i]!);
                } else {
                    flag = false;
                }
            } catch (error) {
                console.log(`Error in async operation for pool ${index}, asset ${i}:`, error);
                counter++;
                continue;
            }
        }
        pool.main = checkHaveTrendingCoin(pool);
        counter++;
        if (flag) {
            try {
                const poolId = await createPool(pool); // 5000 milliseconds (5 seconds) timeout
            } catch (error) {
                console.error('Error creating pool:', error);
            }
        }
    }));
    
    return;
}

// // swap testing code part
// async function main() {
//                                                                                                                                                                                          const mnemonic = `goddess,final,pipe,heart,venture,ship,link,hedgehog,way,receive,ridge,pluck,giraffe,mansion,analyst,provide,easy,cruel,kiss,list,use,laundry,wage,cricket`
//     const keyPair = await mnemonicToWalletKey(mnemonic.split(','));

//     const wallet = tonClient.open(
//         WalletContractV4.create({
//             workchain: 0,
//             publicKey: keyPair.publicKey
//         })
//     );
//     console.log('main');
//     //const jettonAddress = Address.parse('EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO');
//     const jUSDTAddress = Address.parse('EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA');
//     let sender = await wallet.sender(keyPair.secretKey);
//     //sender.address = wallet.address;
//     //await sendTon(mnemonic.split(','), 1000n,"UQAdiv6jJYEY4u12tfsWGXcFMPaq00RTM9bsmbhm4NgHW6B6")
//     //  await sendJetton(
//     //      sender,
//     //      wallet.address,
//     //      jUSDTAddress,
//     //      toNano( 0.00001),
//     //      Address.parse('UQAdiv6jJYEY4u12tfsWGXcFMPaq00RTM9bsmbhm4NgHW6B6')
//     //  )
//     //console.log(keyPair, wallet.address);
//     //await ton_to_Jetton(sender, jettonAddress, 0.00005);
//     //await jetton_to_Ton(sender, wallet.address, jUSDTAddress, 500n);
//     //await jetton_to_Jetton(sender, wallet.address, jettonAddress, jUSDTAddress, 0.00005);
// }
//main();
//fetchPrice(1000000000,'native','EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA');
