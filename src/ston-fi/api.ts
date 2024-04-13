import TonWeb from 'tonweb';

import { Router, ROUTER_REVISION, ROUTER_REVISION_ADDRESS,createJettonTransferMessage } from '@ston-fi/sdk';
import { mnemonicToWalletKey } from '@ton/crypto';
import axios from 'axios';
import { Pool, createPool, deletePoolsCollection } from '../ton-connect/mongo';
import { fetchDataGet } from '../utils';
import { Jetton } from '../dedust/api';
import { toNano } from 'ton-core';

/**
 * This example shows how to swap two jettons using the router contract
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function swapJetton(
    WALLET_ADDRESS: string,
    JETTON0: string,
    JETTON1: string,
    AMOUNT: bigint,
    mnemonic: string[]
) {
    console.log(JETTON0,JETTON1,AMOUNT)
    const provider = new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {
        apiKey: '3c37738fcea8dd1f0362877ddbff2a6dc032fd4562f3343ec83c1eb860d1f00e'
       // apiKey: 'f27c223fbb2cefa9b07fa93ff3c60c50f238d39c912130f4b4ccd8df1a8d2562'
    });
    const tonWeb = new TonWeb(provider);

    const keyPair = await mnemonicToWalletKey(mnemonic);
    const walletClass = tonWeb.wallet.all.v4R2;
    const wallet = new walletClass(provider, {
        publicKey: keyPair.publicKey
    });



    let tonToJettonTxParams;
    
    const router = new Router(tonWeb.provider, {
        revision: ROUTER_REVISION.V1,
        address: ROUTER_REVISION_ADDRESS.V1
    });
    if(JETTON1 == 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c') 
        JETTON1 = 'EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez'
    if(JETTON0 == 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'){
        JETTON0 = 'EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez'
        tonToJettonTxParams = await router.buildSwapProxyTonTxParams({
            // address of the wallet that holds TON you want to swap
            userWalletAddress: WALLET_ADDRESS,
            proxyTonAddress: JETTON0,
            // amount of the TON you want to swap
            offerAmount: new TonWeb.utils.BN(AMOUNT),
            // address of the jetton you want to receive
            askJettonAddress: JETTON1,
            
            // minimal amount of the jetton you want to receive as a result of the swap.
            // If the amount of the jetton you want to receive is less than minAskAmount
            // the transaction will bounce
            minAskAmount: new TonWeb.utils.BN(1),
            // query id to identify your transaction in the blockchain (optional)
            queryId: 5163804699998560,
            // address of the wallet to receive the referral fee (optional)
            referralAddress: undefined,
           });
    }
    // transaction to swap 1.0 JETTON0 to JETTON1 but not less than 1 nano JETTON1
     else
      tonToJettonTxParams = await router.buildSwapJettonTxParams({
        // address of the wallet that holds TON you want to swap
        userWalletAddress: WALLET_ADDRESS,
        offerJettonAddress: JETTON0,
        // amount of the TON you want to swap
        offerAmount: new TonWeb.utils.BN(AMOUNT),
        // address of the jetton you want to receive
        askJettonAddress: JETTON1,
        
        
        // the transaction will bounce
        minAskAmount: new TonWeb.utils.BN(1),
        // query id to identify your transaction in the blockchain (optional)
        queryId: 5163804699998560,
        // address of the wallet to receive the referral fee (optional)
        referralAddress: undefined,
       });

    // to execute the transaction you need to send transaction to the blockchain
    // (replace with your wallet implementation, logging is used for demonstration purposes)
    console.log({
        to: tonToJettonTxParams.to,
        amount: tonToJettonTxParams.gasAmount,
        payload: tonToJettonTxParams.payload
    });
    //return
    
    // reverse transaction is the same,
    // you just need to swap `offerJettonAddress` and `askJettonAddress` values
    // and adjust `offerAmount` and `minAskAmount` accordingly
    const seqno = (await wallet.methods.seqno().call()) || 0;
    
    var result = await wallet.methods
        .transfer({
            secretKey: keyPair.secretKey,
            toAddress: tonToJettonTxParams.to,
            amount: new TonWeb.utils.BN(1000000000/10*3),
            seqno: seqno,

            payload: tonToJettonTxParams.payload
        })
        .send();
    console.log(result);
    return;
    
}
function checkHaveTrendingCoin(pool: Pool){
    if ( //maintain only trending currencies
        pool.assets[0] == 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' //||
        //pool.assets[0] == 'jetton:EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA' || //jUSDT
        //pool.assets[0] == 'jetton:EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE' || //SCALE
        //pool.assets[0] == 'jetton:EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728' //jUSDC
    ) return 0; 
    else if (
        pool.assets[1] == 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' //||
        // pool.assets[1] == 'jetton:EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA' || //jUSDT
        // pool.assets[1] == 'jetton:EQBlqsm144Dq6SjbPI4jjZvA1hqTIP3CvHovbIfW_t-SCALE' || //SCALE
        // pool.assets[1] == 'jetton:EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728' //jUSDC
    ) return 1;
    else return -1;
}
export async function getStonPair() {
    let counter = 0;
    //fetch data
    const assets: Jetton[] = await fetchDataGet('/assets', 'ston');
    
    const extPrice: {symbol:string, price: number}[] = await fetchDataGet('/prices', 'dedust');
    //TON price
    const nativePrice = extPrice.find(p => p.symbol === 'USDT')?.price || 0;
    let pools: Pool[] = await fetchDataGet('/pools', 'ston');
    console.log(typeof pools);
    pools = pools.filter(pool => checkHaveTrendingCoin(pool) >= 0 && pool!.reserves![0]! > toNano(100));
    pools.sort((a,b) => {
    return  b.totalSupply - a.totalSupply 
    })
    await Promise.all(pools.map(async (pool, index) => {
        pool.caption = ['', ''];
        pool.prices = [0, 0];
        pool.TVL = 0;
        pool.decimals = [0,0];
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
                //pool.TVL += (pool.prices[i]! * pool.reserves[i]!);
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
