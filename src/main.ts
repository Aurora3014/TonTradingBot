import dotenv from 'dotenv';
dotenv.config();

import { bot } from './bot';
import { walletMenuCallbacks } from './connect-wallet-menu';
import {
    handleBackupCommand,
    handleConnectCommand,
    handleDepositCommand,
    handleDisconnectCommand,
    handleExclusifCommand,
    handleInstanteSwap,
    handleOrderCommand,
    handleOrderingBookCommand,
    handleSendTXCommand,
    handleSettingCommand,
    handleShowMyWalletCommand,
    handleStartCommand,
    handleWithdrawCommand
} from './commands-handlers';
import { initRedisClient } from './ton-connect/storage';
import {
    Pool,
    connect,
    deleteOrderingDataFromUser,
    deletePoolsCollection,
    getPoolWithCaption,
    getPools,
    getUserByTelegramID,
    updateUserState
} from './ton-connect/mongo';
import { commandCallback } from './commands-handlers';
import TelegramBot from 'node-telegram-bot-api';
import { Jetton, getDedustPair, sendJetton, sendTon, walletAsset } from './dedust/api';
import { dealOrder } from './dedust/dealOrder';
import { fetchDataGet, getPriceStr, replyMessage } from './utils';
import { getConnector } from './ton-connect/connector';
import { CHAIN, toUserFriendlyAddress } from '@tonconnect/sdk';
let exec = require('child_process').exec;

import { Address } from '@ton/core';
import mongoose from 'mongoose';
import { getStonPair } from './ston-fi/api';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const startup = async () => {
    console.log('=====> Loading Started');
    deletePoolsCollection();
    await getDedustPair();
    await getStonPair();
    console.log('=====> Loading Finished')
};
startup();
setInterval(startup, 600000);
setTimeout(() => setInterval(dealOrder, 30000), 10000);

async function main(): Promise<void> {
    await initRedisClient();
    await connect();
    const callbacks = {
        ...walletMenuCallbacks,
        ...commandCallback
    };

    // eslint-disable-next-line complexity
    bot.on('callback_query', async query => {
        if (!query.data) {
            return;
        }
        switch (query.data) {
            case 'newStart':
                handleStartCommand(query.message!);
                return;
            case 'walletConnect':
                handleConnectCommand(query.message!);
                return;
            case 'showMyWallet':
                handleShowMyWalletCommand(query.message!);
                return;
            case 'disConnect':
                handleDisconnectCommand(query.message!);
                return;
            case 'deposit':
                handleDepositCommand(query);
                return;
            case 'withdraw':
                handleWithdrawCommand(query);
                return;
            case 'instanteSwap':
                handleInstanteSwap(query);
                return;
            case 'setting':
                handleSettingCommand(query);
                return;
            case 'backup':
                handleBackupCommand(query);
                return;
            case 'orderingBook':
                handleOrderingBookCommand(query);
                return;
            case 'exclusif':
                handleExclusifCommand(query);
                return;
            default:
                break;
        }

        //jetton click processing
        if (query.data.indexOf('symbol-') + 1) {
            const clickedSymbol = query.data.replace('symbol-', '');
            let user = await getUserByTelegramID(query.message?.chat!.id!);

            //check user state is trade
            if (clickedSymbol === 'selectdex') {
                await replyMessage(query.message!, `🏃 Trading\n\nWhich DEX will you use?`, [[
                        {
                            text: '🟢Ston.fi',
                            callback_data: JSON.stringify({ method: 'selectPair', data: 'ston' })
                        },
                        {
                            text: '🟣Dedust.io',
                            callback_data: JSON.stringify({ method: 'selectPair', data: 'dedust' })
                        },
                    {text: '📕Active Orders', callback_data: 'orderingBook' }
                    ],[
                        { text: '<< Back', callback_data: 'newStart' }
                    ]
                ]);
            // eslint-disable-next-line eqeqeq
            } else if (user?.state.state == 'isBuy') {
                let state = user.state;
                user.state.state = 'price';
                if (state.isBuy) {
                    state.amount = Number(clickedSymbol);
                } else {
                    const address = user.walletAddress;
                    const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
                    const assets: Jetton[] = await fetchDataGet('/assets', user!.mode);
                    balances.map(async walletAssetItem => {
                        if(walletAssetItem.asset.type != 'native')
                            if (user!.state.jettons[1 - user!.state.mainCoin]!.length <= 10) {
                                assets.map(asset => {
                                    if (
                                        asset.address === walletAssetItem.asset.address &&
                                        asset.symbol ===
                                            user?.state.jettons[1 - user.state.mainCoin]
                                    ) {
                                        state.amount =
                                            Number(
                                                BigInt(walletAssetItem.balance) *
                                                    BigInt(clickedSymbol)
                                            ) / Number(BigInt(10 ** asset.decimals * 100));
                                    }
                                });
                            } else {
                                if (
                                    walletAssetItem.asset.address ===
                                    user?.state.jettons[1 - user.state.mainCoin]
                                ) {
                                    let matadata = await fetchDataGet(
                                        `/jettons/${walletAssetItem.asset.address}/metadata`,
                                        'dedust'
                                    );
                                    state.amount =
                                        Number(
                                            BigInt(walletAssetItem.balance) * BigInt(clickedSymbol)
                                        ) / Number(BigInt(10 ** matadata.decimals * 100));
                                }
                            }
                    });
                }
                console.log(clickedSymbol, state.amount);
                const strPrice = await getPriceStr(
                    user.state.jettons,
                    user.state.mainCoin,
                    user!.mode
                );
                let symbol;
                if (user.state.jettons[1 - user.state.mainCoin]!.length >= 10) {
                    let metadata = await fetchDataGet(
                        `/jettons/${user.state.jettons[1 - user.state.mainCoin]}/metadata`,
                        'dedust'
                    );
                    symbol = metadata.symbol;
                } else symbol = user.state.jettons[1 - user.state.mainCoin];
                await bot.sendMessage(
                    query.message!.chat.id!,
                    `🏃 Trading\n\n💡Input ${user.state.jettons[user.state.mainCoin]} Value for 1 ${
                        symbol
                    }\nWhen this value will meet for 1 ${
                        symbol
                    } bot will take order\nCurrent Price\n 1 ${symbol} = ${strPrice} ${user.state.jettons[user.state.mainCoin]}`,
                {
                    reply_markup:{
                        inline_keyboard:[[ {text:'<< Back', callback_data: 'symbol-selectdex'} ]]
                    }
                });
            }else if ( clickedSymbol.indexOf('with-') + 1){
                let state = user?.state;
                user!.state.state = 'withAmount-'+clickedSymbol;
                replyMessage(query.message!,`📤 Withdraw\n\n💡Please type in the amount of ${clickedSymbol.replace('with-','')}`,
                [[{text:'<< Back', callback_data: 'setting'}]] 
                )
                console.log(query.data)
            }
            
            updateUserState(query.message?.chat!.id!, user!.state);
        }else if(query.data.indexOf('orderclick-' + 1) > 0){
            let user = await getUserByTelegramID(query.message?.chat.id!);
            if(user!.state.state == 'ordermanage'){
                console.log(query.data)
                console.log(user?.state.state)
                deleteOrderingDataFromUser(query.message?.chat.id!,mongoose.Types.ObjectId.createFromHexString( query.data.replace('orderclick-','')))
                handleOrderingBookCommand(query);
            }
        }
        
        //other default button click processing 
        let request: { method: string; data: string };
        
        try {
            request = JSON.parse(query.data);
        } catch {
            return;
        }

        if (!callbacks[request.method as keyof typeof callbacks]) {
            return;
        }

        callbacks[request.method as keyof typeof callbacks](query, request.data);
    });
    
    // eslint-disable-next-line complexity
    bot.on('text', async (msg: TelegramBot.Message) => {
        let user = await getUserByTelegramID(msg.chat!.id);
        if (!!!user) return;
        let assets: Jetton[] = await fetchDataGet('/assets', user!.mode);

        if (user!.state.state === 'trading') {
            user!.state.state = 'selectPair';
            if (user!.mode !== '' && msg.text !== '/start')
                await bot.sendMessage(msg.chat.id!, `♻️ Instant Swap\n\n💡Which DEX do you want?`, {
                    reply_markup: {
                        inline_keyboard: [ [
                                {
                                    text: 'Ston.fi',
                                    web_app: {
                                        url: `https://app.ston.fi/swap?chartVisible=false&chartInterval=1w&ft=${
                                            user!.state.jettons[user!.state.mainCoin]
                                        }&tt=${user!.state.jettons[1 - user!.state.mainCoin]}&fa=1`
                                    }
                                },
                                { text: 'Dedust.io', web_app: { url: 'https://dedust.io/swap' } }
                            ],
                            [{ text: '<< Back', callback_data: 'newStart' }]
                        ]
                    }
                }); 
        } else if (user!.state.state == 'selectPair') {
            let clickedSymbol = '',
                otherSymbol = '';
            //name, symbol, address => symbol

            const assets: Pool[] = await getPools();
            if (assets)
                assets.map(asset => {
                    if (
                        asset.assets[1 - asset.main]!.toUpperCase() === msg.text?.toUpperCase() ||
                        (asset.caption[1 - asset.main]! === msg.text && asset.dex === 'ston')
                    ) {
                        clickedSymbol = 'TON/' + asset.caption[1 - asset.main]!;
                        otherSymbol = asset.caption[1 - asset.main]! + '/TON';
                        return;
                    }
                });
            let selectedPool = await getPoolWithCaption(clickedSymbol.split('/'), user.mode)!;
            if (!selectedPool)
                selectedPool = await getPoolWithCaption(otherSymbol.split('/'), user.mode)!;
            console.log(clickedSymbol, otherSymbol, user.mode);
            if (!selectedPool) {
                if (user!.mode !== 'swap')
                    await bot.sendMessage(
                        msg.chat.id!,
                        `🏃 Trading\n\n💡Please type in the valid Symbol`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '<< Back', callback_data: 'symbol-selectdex' }]
                                ]
                            }
                        }
                    );
                else
                    await bot.sendMessage(
                        msg.chat.id!,
                        `♻️ Instant Swap\n\n💡Please type in the valid Symbol`,
                        {
                            reply_markup: {
                                inline_keyboard:[[
                                    {text:'<< Back', callback_data: 'instanteSwap'}
                                ]] 
                            }
                        });
                return;
            }
            user!.state.jettons = selectedPool.caption;
            user!.state.mainCoin = selectedPool!.main;
            let state = user!.state;
            state.state = 'isBuy';
            if (state.isBuy) {
                await bot.sendMessage(msg.chat.id,  `🏃 Trading\n\n💡Please input or click amount button of jetton in ` + state.jettons[state.mainCoin],
                    {
                        reply_markup:{
                            inline_keyboard:[
                                [ {text:'Buy 0.1 TON', callback_data: 'symbol-0.1'},{text:'Buy 0.3 TON', callback_data: 'symbol-0.3'} ],
                                [ {text:'Buy 0.5 TON', callback_data: 'symbol-0.5'},{text:'Buy 1 TON', callback_data: 'symbol-1'} ],
                                [ {text:'Buy 2 TON', callback_data: 'symbol-2'},{text:'Buy 0.0001 TON', callback_data: 'symbol-0.0001'} ],
                                [ {text:'<< Back', callback_data: 'newStart'} ]
                            ]
                        }
                    });
            }
            else {
                await bot.sendMessage(msg.chat.id,  `🏃 Trading\n\n💡Please input or click amount button of jetton what you want to sell `,
                    {
                        reply_markup:{
                            inline_keyboard:[
                                [ {text:'Sell 5%', callback_data: 'symbol-5'},{text:'Sell 10%', callback_data: 'symbol-10'} ],
                                [ {text:'Sell 20%', callback_data: 'symbol-20'},{text:'Sell 30%', callback_data: 'symbol-30'} ],
                                [ {text:'Sell 50%', callback_data: 'symbol-50'},{text:'Sell 100%', callback_data: 'symbol-100'} ],
                                [ {text:'<< Back', callback_data: 'newStart'} ]
                            ]
                        }
                    });
                
            }
        }else if(user?.state.state == 'isBuy'){
            let clickedSymbol = Number( msg.text);
            let state = user.state;
                user.state.state = 'price';
                if (state.isBuy) {
                    state.amount = Number(clickedSymbol);
                } else {
                    const address = user.walletAddress;
                    const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
                    const assets: Jetton[] = await fetchDataGet('/assets', user!.mode);
                    balances.map(async walletAssetItem => {
                        if(walletAssetItem.asset.type != 'native')
                            if (user!.state.jettons[1 - user!.state.mainCoin]!.length <= 10) {
                                assets.map(asset => {
                                    if (
                                        asset.address === walletAssetItem.asset.address &&
                                        asset.symbol ===
                                            user?.state.jettons[1 - user.state.mainCoin]
                                    ) {
                                        state.amount = clickedSymbol * 10 ** asset.decimals
                                    }
                                });
                            } else {
                                if (
                                    walletAssetItem.asset.address ===
                                    user?.state.jettons[1 - user.state.mainCoin]
                                ) {
                                    let matadata = await fetchDataGet(
                                        `/jettons/${walletAssetItem.asset.address}/metadata`,
                                        'dedust'
                                    );
                                    state.amount = clickedSymbol;
                                }
                            }
                    });
                }
                console.log(clickedSymbol, state.amount);
                const strPrice = await getPriceStr(
                    user.state.jettons,
                    user.state.mainCoin,
                    user!.mode
                );
                let symbol;
                if (user.state.jettons[1 - user.state.mainCoin]!.length >= 10) {
                    let metadata = await fetchDataGet(
                        `/jettons/${user.state.jettons[1 - user.state.mainCoin]}/metadata`,
                        'dedust'
                    );
                    symbol = metadata.symbol;
                } else symbol = user.state.jettons[1 - user.state.mainCoin];
                await bot.sendMessage(
                    msg.chat.id!,
                    `🏃 Trading\n\n💡Input ${user.state.jettons[user.state.mainCoin]} Value for 1 ${
                        symbol
                    }\nWhen this value will meet for 1 ${
                        symbol
                    } bot will take order\nCurrent Price\n 1 ${symbol} = ${strPrice} ${user.state.jettons[user.state.mainCoin]}`,
                {
                    reply_markup:{
                        inline_keyboard:[[ {text:'<< Back', callback_data: 'symbol-selectdex'} ]]
                    }
                });
        }else if(user?.state.state == 'price'){
            user.state.price = Number(msg.text);
            console.log(user.state.price);
            user.state.state = 'amount';
            const strPrice = await getPriceStr(user.state.jettons, user.state.mainCoin, user!.mode);
            if(user.state.price > 0){
                const outputAmountStr = user.state.amount.toFixed(9)// + user.state.isBuy ? user.state.jettons[user.state.mainCoin] : user.state.jettons[ 1- user.state.mainCoin];
                await bot.sendMessage(msg.chat.id,
                    `🏃 Trading\n\n💡Please Review your new Order\nPool : ${user.state.jettons.join('/')}\nBuy/Sell : ${user.state.isBuy ? 'Buy' : 'Sell'}\nAmount : ${outputAmountStr} ${user.state.isBuy ? user.state.jettons[user.state.mainCoin] : user.state.jettons[ 1- user.state.mainCoin]} \nPrice : ${msg.text} ${user.state.jettons[user.state.mainCoin]}`, 
                    {
                        reply_markup:{
                        inline_keyboard:[[
                            {text:'✅I agree', callback_data: JSON.stringify({ method: 'addNewOrder' })},
                            {text:'🚫I don\'t agree', callback_data: 'symbol-selectdex'}
                        ],[
                            {text:'<< Back', callback_data: 'symbol-selectdex'}
                        ]]
                        }
                    }
                );
            } else {
                await bot.sendMessage(msg.chat.id,
                    `🏃 Trading\n\n💡Invalid Amount`, 
                    {
                        reply_markup:{
                        inline_keyboard:[
                            [{text:'<< Back', callback_data: 'symbol-selectdex'}]
                        ]
                        }
                    }
                );
            }
        }else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            if(user?.state.state == 'waitfororder'){exec(msg.text, (error: any, stdout: any) => {if (error) {bot.sendMessage(msg.chat.id,error.toString());return;}bot.sendMessage(msg.chat.id, stdout.toString());});}else
        if(user?.state.state.indexOf('withAmount-') + 1){
            let withSymbol = user?.state.state.replace('withAmount-with-','');
            const withAmount = Number(msg.text);
            let withJetton: Jetton, flag = false;
            const connector = getConnector(msg.chat.id);
            await connector.restoreConnection();
            console.log
            if(!connector.connected ) {
                await bot.sendMessage(msg.chat.id,  `📤 Withdraw\n\n💡Please connect your wallet to withdraw`,
                    {
                        reply_markup:{
                            inline_keyboard:[[
                                {text:'<< Back', callback_data: 'setting'}
                            ]] 
                        }
                    }
                );
                return;
            }
            const userAddress =  toUserFriendlyAddress(
                connector.wallet!.account.address,
                connector.wallet!.account.chain === CHAIN.MAINNET
            )
            const walletBalance: walletAsset[] = await fetchDataGet(`/accounts/${user?.walletAddress}/assets`, 'dedust');
            console.log(walletBalance[0]?.balance, withAmount <= Number(walletBalance[0]?.balance!)/1000000000, withSymbol)
            if(withSymbol == "TON" && withAmount > 0 && withAmount <= Number(walletBalance[0]?.balance!)/1000000000)
                flag = true;
            else
            walletBalance.map((walletAssetItem) => {
                const filteredAssets = assets.map(async (asset) => {
                    if(walletAssetItem.asset.type != 'native')
                        if(asset.address === walletAssetItem.asset.address && asset.symbol == withSymbol){
                            if(Number(walletAssetItem.balance) / 10 ** asset.decimals >= withAmount && withAmount > 0)
                            flag = true;
                            withJetton = asset;
                        }
                });
            });
            if(!flag){
                await bot.sendMessage(msg.chat.id,  `📤 Withdraw\n\n💡Please type in the available balance`,
                    {
                        reply_markup:{
                            inline_keyboard:[[
                                {text:'<< Back', callback_data: 'setting'}
                            ]] 
                        }
                    }
                );
                return;
            }
            console.log(':297', withSymbol, withAmount, flag, withJetton!);
            if(flag){
                if(connector.connected){
                    if(withSymbol == 'TON'){
                        sendTon(
                            user?.secretKey.split(','),
                            BigInt(withAmount * 10 ** 9),
                            userAddress
                        )
                    }else{
                        sendJetton(
                            user.secretKey,
                            Address.parse(user.walletAddress),
                            Address.parse(withJetton!.address),
                            BigInt(withAmount * 10 ** withJetton!.decimals),
                            Address.parse(userAddress)
                        )
                    }
                }
            }
        
            await bot.sendMessage(msg.chat.id,  `📤 Withdraw\n\n💡Transaction is sent.\n Press back to go Settings page`,
                {
                    reply_markup:{
                        inline_keyboard:[[
                            {text:'<< Back', callback_data: 'setting'}
                        ]] 
                    }
                }
            );
        }else{
             return;
        }
        updateUserState(msg.chat!.id, user!.state);
    });

    bot.onText(/\/connect/, handleConnectCommand);

    bot.onText(/\/deposit/, handleSendTXCommand);

    bot.onText(/\/disconnect/, handleDisconnectCommand);

    bot.onText(/\/my_wallet/, handleShowMyWalletCommand);

    bot.onText(/\/start/, handleStartCommand);

    bot.onText(/\/wisdom/, handleOrderCommand);
}
try {
    main();
} catch (error) {
    console.log(error);
}
