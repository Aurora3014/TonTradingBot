import { deleteOrderingDataFromUser, getAllUsers, getAltTokenWithAddress, getPoolWithCaption } from '../ton-connect/mongo';
import { Address, TonClient4, WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { fetchPrice, jetton_to_Jetton, jetton_to_Ton, ton_to_Jetton } from './api';
const tonClient = new TonClient4({ endpoint: 'https://mainnet-v4.tonhubapi.com' });
import { bot } from '../bot';
import { swapJetton } from '../ston-fi/api';
import { fetchDataGet } from '../utils';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function dealOrder() {
    console.log('=======> dealing order started');
    const users = await getAllUsers();
    users!.map(async user => {

        if (user.orderingData)
            user.orderingData!.map(async order => {
                let mnemonic = order.walletSecretKey.split(',');
                let keyPair = await mnemonicToPrivateKey(mnemonic);

                const wallet = tonClient.open(
                    WalletContractV4.create({
                        workchain: 0,
                        publicKey: keyPair!.publicKey
                    })
                );

                let sender = await wallet.sender(keyPair.secretKey);
                //mainCoin refers to the coin what I have and want to exchange.
                const pool = await getPoolWithCaption(order.jettons, order.dex);
                const mainCoinId: number = order.isBuy ? order.mainCoin : 1 - order.mainCoin;
                const fromJetton: string = order.jettons[mainCoinId]!;
                const fromAddress: string = pool!.assets[mainCoinId]!.replace('jetton:', '');
                const toJetton: string = order.jettons[1 - mainCoinId]!;
                const toAddress: string = pool!.assets[1 - mainCoinId]!.replace('jetton:', '');
                if (pool!.decimals[1 - order.mainCoin]! === 0) {
                    let metadata = await getAltTokenWithAddress(
                        order.jettons[1 - order.mainCoin]!,
                        'dedust'
                    );
                    pool!.decimals[1 - order.mainCoin] = Number(metadata!.decimals);
                }
                const amount = BigInt(Math.floor(10 ** pool?.decimals[mainCoinId]! * order.amount)); //unit in ton fo rton=>jetton

                //ton_to_jetton case
                try {
                    console.log('start tx');
                    const pricePost = await fetchPrice(
                        10 ** pool!.decimals[1 - order.mainCoin]!,
                        pool!.assets[1 - order.mainCoin]!,
                        pool!.assets[order.mainCoin]!,
                        order.dex
                    );
                    //compare price and send tx , delete document.
                    console.log(
                        pricePost * (order.isBuy ? 1 : -1),
                        (order.price * 10 ** pool!.decimals[mainCoinId]!) * (order.isBuy ? 1 : -1)
                    );
                    if (
                        pricePost * (order.isBuy ? 1 : -1) <=
                            order.price *
                                10 ** pool!.decimals[mainCoinId]! *
                                (order.isBuy ? 1 : -1) &&
                        Number(pricePost) !== 0
                    ) {
                        if (order.dex === 'dedust') {
                            if (fromJetton === 'TON') {
                                await ton_to_Jetton(sender, Address.parse(toAddress), amount);
                                console.log('ton => jetton')
                            } else if (toJetton === 'TON') {
                                await jetton_to_Ton(
                                    sender,
                                    wallet.address,
                                    Address.parse(fromAddress),
                                    amount
                                );
                                console.log('jetton => ton')
                            } else {
                                await jetton_to_Jetton(
                                    sender,
                                    wallet.address,
                                    Address.parse(fromAddress),
                                    Address.parse(toAddress),
                                    amount
                                );
                            }
                            bot.sendMessage(
                                user.telegramID,
                                'TX realised, Visit https://tonviewer.com/' + wallet.address.toString()
                            );
                        } else if (order.dex === 'ston') {
                            await swapJetton(
                                wallet.address.toString(),
                                fromAddress,
                                toAddress,
                                amount,
                                mnemonic
                            );
                            bot.sendMessage(
                                user.telegramID,
                                'TX realised, Visit https://tonviewer.com/' + wallet.address.toString()
                            );
                        }
                         deleteOrderingDataFromUser(user.telegramID, order!._id);
                    }
                } catch (error) {
                    console.log(error);
                }
            });
    });
    console.log('=====> dealing order Finished');
}


