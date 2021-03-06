const fauna = require("faunadb");
const dotenv = require("dotenv");
const axios = require("axios");
const ApiError = require("../error/ApiError.js");
const apiErrorHandler = require("../error/api-error-handler.js");
const EthDater = require("ethereum-block-by-date");
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const web3 = createAlchemyWeb3("https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY);
const abiDecoder = require("abi-decoder");

dotenv.config();

const q = fauna.query;
const client = new fauna.Client({
    secret: process.env.FAUNA_SECRET,
});

const dater = new EthDater(
    web3 // Web3 object, required.
);

const dateFormat = (d) => {
    let dString = d.getFullYear() + "-";
    if (d.getMonth() < 9) {
        dString += "0" + (d.getMonth() + 1);
    } else {
        dString += d.getMonth() + 1;
    }
    dString += "-";
    if (d.getDate() < 10) dString += "0" + d.getDate();
    else dString += d.getDate();

    return dString;
};
module.exports.dateFormat = dateFormat;

const round2Dec = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
};
module.exports.round2Dec = round2Dec;

const getHistoryItem = async (contract, date) => {
    let returnObjFaunaGetToday;
    try {
        returnObjFaunaGetToday = await client.query(
            q.Map(
                q.Paginate(q.Match(q.Index("history_by_fund_date"), [contract, date])),
                q.Lambda("x", q.Get(q.Var("x")))
            )
        );
    } catch (err) {
        console.log(err);
    }

    if (returnObjFaunaGetToday.data.length !== 0) return returnObjFaunaGetToday.data[0].data;
    else return false;
};

const getAssetPrice = async (data) => {
    let url,
        priceData = {
            usd: 0,
            eur: 0,
        };

    if (data.type === "erc20") {
        url =
            "https://api.coingecko.com/api/v3/simple/token_price/ethereum/?contract_addresses=" +
            data.contract +
            "&vs_currencies=usd%2Ceur";
    } else if (data.type === "asset") {
        url = "https://api.coingecko.com/api/v3/simple/price?ids=" + data.asset + "&vs_currencies=usd%2Ceur";
    }

    try {
        let getAssetPrice = await axios({
            method: "get",
            url: url,
            headers: {
                accept: "application/json",
            },
        });
        if (Object.keys(getAssetPrice.data)[0] !== undefined)
            priceData = getAssetPrice.data[Object.keys(getAssetPrice.data)[0]];
    } catch (error) {
        console.log("Could not get price data for ", data, error);
        return false;
    }

    return priceData;
};

const updateCurvePool = async (poolAddr) => {
    console.log("-- processing Curve pool " + poolAddr);

    // only for contract string, fetch fund from db
    let returnObjFaunaGetCurve;
    try {
        returnObjFaunaGetCurve = await client.query(
            q.Map(
                q.Paginate(q.Match(q.Index("curvepools_by_contract"), poolAddr)),
                q.Lambda(
                    "x",
                    q.Let(
                        {
                            pool: q.Get(q.Var("x")),
                        },
                        {
                            ref: q.Var("x"),
                            contract: q.Select(["data", "contract"], q.Var("pool")),
                            token: q.Let(
                                {
                                    tokenDoc: q.Get(
                                        q.Match(
                                            q.Index("assets_by_contract"),
                                            q.Select(["data", "token"], q.Var("pool"))
                                        )
                                    ),
                                },
                                {
                                    name: q.Select(["data", "name"], q.Var("tokenDoc")),
                                    contract: q.Select(["data", "contract"], q.Var("tokenDoc")),
                                    decimals: q.Select(["data", "decimals"], q.Var("tokenDoc")),
                                    ABI: q.Select(["data", "ABI"], q.Var("tokenDoc")),
                                }
                            ),
                            name: q.Select(["data", "name"], q.Var("pool")),
                            ABI: q.Select(["data", "ABI"], q.Var("pool")),
                            assets: q.Map(
                                q.Select(["data", "assets"], q.Var("pool")),
                                q.Lambda(
                                    "asset",
                                    q.Let(
                                        {
                                            assetDoc: q.Get(
                                                q.Match(
                                                    q.Index("assets_by_contract"),
                                                    q.Select("contract", q.Var("asset"))
                                                )
                                            ),
                                        },
                                        {
                                            id: q.Select("id", q.Var("asset")),
                                            name: q.Select(["data", "name"], q.Var("assetDoc")),
                                            contract: q.Select("contract", q.Var("asset")),
                                            decimals: q.Select(["data", "decimals"], q.Var("assetDoc")),
                                            amount: q.Select("amount", q.Var("asset")),
                                            alt: q.Select("alt", q.Var("asset"), null),
                                        }
                                    )
                                )
                            ),
                        }
                    )
                )
            )
        );
    } catch (error) {
        console.log(error);
    }
    if (returnObjFaunaGetCurve.data.length !== 0) {
        pool = returnObjFaunaGetCurve.data[0];
    } else {
        return false;
    }

    console.log("-- Pool name: " + pool.name);

    const curvePoolInstance = new web3.eth.Contract(pool.ABI, pool.contract);

    console.log("-- determine amounts for each asset in this pool");

    // update asset amounts for all assets in the pool
    for (let asset of pool.assets) {
        console.log("-- getting amount for " + asset.name);
        let nrDecimals = moveDecPoint(asset.decimals);

        let amount = await curvePoolInstance.methods.balances(asset.id).call();
        let amountProcessed = amount / nrDecimals;
        asset.amount = amountProcessed;

        console.log("-- amount in pool: " + amountProcessed);

        delete asset.decimals;
    }

    // determine number of outstanding LP tokens
    const curvePoolTokenInstance = new web3.eth.Contract(pool.token.ABI, pool.token.contract);

    const outStandingTokens = await curvePoolTokenInstance.methods.totalSupply().call();
    const outStandingTokensProcessed = Number(outStandingTokens) / moveDecPoint(pool.token.decimals);
    console.log("-- Total supply for " + pool.name, outStandingTokensProcessed);

    console.log("-- saving updated pool data to db");

    try {
        let returnObjSavePool = await client.query(
            q.Update(pool.ref, {
                data: {
                    assets: pool.assets,
                    tokenSupply: outStandingTokensProcessed,
                },
            })
        );
    } catch (error) {
        console.log("Could nt update pool data ", error);
    }

    console.log("-- Done with pool " + poolAddr);
    console.log("--");
    console.log("--");
};

module.exports.updateCurvePool = updateCurvePool;

module.exports.updateContract = async (fund) => {
    let theAssetPrices = {};

    if (typeof fund === "string") {
        // only for contract string, fetch fund from db
        let returnObjFaunaGetFunds;
        try {
            returnObjFaunaGetFunds = await client.query(
                q.Map(q.Paginate(q.Match(q.Index("fund_by_contract"), fund)), q.Lambda("x", q.Get(q.Var("x"))))
            );
        } catch (error) {
            console.log(error);
        }
        //console.log(returnObjFaunaGetFunds);
        if (returnObjFaunaGetFunds.data.length !== 0) {
            fund = returnObjFaunaGetFunds.data[0];
        } else {
            return false;
        }
    }

    console.log("-- Processing contract " + fund.data.name + " (" + fund.data.contract + ")");

    let contractABI = "";

    // If there's no ABI stored for this contract, let's sort that out
    if (!fund.data.hasOwnProperty("ABI")) {
        console.log("-- No ABI stored for contract, fixing...");
        let returnObj = await axios({
            method: "get",
            url: "https://api.etherscan.io/api",
            params: {
                module: "contract",
                action: "getabi",
                address: fund.data.contract,
                apikey: process.env.ETHERSCAN_API_KEY,
            },
        });

        contractABI = JSON.parse(returnObj.data.result);

        try {
            let returnObjSaveABI = await client.query(
                q.Update(fund.ref, {
                    data: {
                        ABI: contractABI,
                    },
                })
            );
        } catch (error) {}
    } else {
        console.log("-- Using stored ABI for contract.");
        contractABI = fund.data.ABI;
    }

    const instance = new web3.eth.Contract(contractABI, fund.data.contract);
    const decimals = await instance.methods.decimals().call();
    const nrDecimals = moveDecPoint(decimals);

    // if there's no activation data, let's sort that out
    let block;
    if (!fund.data.hasOwnProperty("activationStamp")) {
        console.log("-- no activation data, pulling from chain and saving... ");
        const activation = await instance.methods.activation().call();
        const date = new Date(activation * 1000);

        block = await dater.getDate(date, true);

        try {
            let returnObjSaveActivation = await client.query(
                q.Update(fund.ref, {
                    data: {
                        activationStamp: activation,
                        activationBlock: block,
                    },
                })
            );
        } catch (error) {}
        fund.data.activationBlock = block;
        fund.data.activationStamp = activation;
    } else {
        console.log("-- activation data present, using saved data.");
        block = fund.data.activationBlock;
    }

    const perShare = await instance.methods.pricePerShare().call(undefined, block.block);

    let today = new Date();
    let d = new Date(block.timestamp * 1000);
    if (fund.data.hasOwnProperty("lastUpdate")) {
        let dateSplit = fund.data.lastUpdate.split("-");

        d = new Date(Date.UTC(Number(dateSplit[0]), Number(dateSplit[1] - 1), Number(dateSplit[2]) + 1));
        console.log("-- picking up at date: " + d, dateSplit);
    }
    let dates = [];

    // loop from d until today
    let sharePriceToday = 1;
    for (d; d <= today; d.setDate(d.getDate() + 1)) {
        let block = await dater.getDate(d, true);
        let perShare = await instance.methods.pricePerShare().call(undefined, block.block);

        let dString = dateFormat(d);

        let perShareEth = Number(perShare) / nrDecimals;
        console.log("-- " + dString, block.block, perShareEth);

        // add entry to database
        let returnObjFaunaAddHistory;
        try {
            returnObjFaunaAddHistory = await client.query(
                q.Call(q.Function("UpdateHistory"), [
                    fund.ref.id,
                    fund.data.name,
                    fund.data.contract.toLowerCase(),
                    dString,
                    perShareEth,
                ])
            );
        } catch (error) {
            console.log(error);
        }
    }

    // for Curve vaults, let figure out the current LP token price
    // non-curve faults won't have this property
    if (fund.data.poolContract !== undefined) {
        console.log("-- Underlying asset is a Curve LP token");
        // this is a curve vault, with a poolContract
        // anything stored for fund.data.poolContract?
        let poolContractABI;

        let returnObjPoolContract;
        try {
            returnObjPoolContract = await client.query(
                q.Map(
                    q.Paginate(q.Match(q.Index("curvepools_by_contract"), fund.data.poolContract)),
                    q.Lambda("x", q.Get(q.Var("x")))
                )
            );
        } catch (err) {
            console.log("Could not query db for Curve pool data");
        }

        console.log("-- ABI stored for pool contract, using ...");
        poolContractABI = returnObjPoolContract.data[0].data.ABI;

        // let's determine the value for this pool's LP token
        console.log("-- determine total value of pool");
        let returnObjPool;
        try {
            returnObjPool = await client.query(
                q.Map(
                    q.Paginate(q.Match(q.Index("curvepools_by_contract"), fund.data.poolContract)),
                    q.Lambda("x", q.Get(q.Var("x")))
                )
            );
        } catch (error) {
            console.log("Could not load pool data for " + fund.data.poolContract, error);
        }

        if (returnObjPool.data.length > 0) {
            console.log("-- looping through pool assets");
            let totalValuePool = {
                usd: 0,
                eur: 0,
            };
            let lpTokenPrices = {
                usd: 0,
                eur: 0,
            };
            for (let asset of returnObjPool.data[0].data.assets) {
                const totalValueAsset = {};

                console.log("-- processing: " + asset.name);
                //console.log(asset);

                let priceData = {
                    usd: 0,
                    eur: 0,
                };

                let addr = asset.alt !== undefined ? asset.alt.contract : asset.contract;
                console.log("addr", addr);

                if (asset.name === "ETH") {
                    priceData = await getAssetPrice({ type: "asset", asset: "ethereum" });
                } else {
                    priceData = await getAssetPrice({ type: "erc20", contract: addr });
                }

                console.log("-- priceData for " + asset.name, priceData);

                if (priceData.usd !== undefined) {
                    totalValueAsset.usd = asset.amount * priceData.usd;
                    totalValuePool.usd += totalValueAsset.usd;
                    console.log("-- total value for " + asset.name + " in USD: " + totalValueAsset.usd);
                    console.log("-- total value entire pool in USD: " + totalValuePool.usd);
                }
                if (priceData.eur !== undefined) {
                    totalValueAsset.eur = asset.amount * priceData.eur;
                    totalValuePool.eur += totalValueAsset.eur;
                    console.log("-- total value for " + asset.name + " in EUR: " + totalValueAsset.eur);
                    console.log("-- total value entire pool in EUR: " + totalValuePool.eur);
                }

                asset.totalValueAsset = totalValueAsset;
                console.log("-- pool total value after processing " + asset.name, totalValuePool);
            }

            // calculate LP token prices
            lpTokenPrices.usd = totalValuePool.usd / returnObjPool.data[0].data.tokenSupply;
            lpTokenPrices.eur = totalValuePool.eur / returnObjPool.data[0].data.tokenSupply;

            theAssetPrices = lpTokenPrices;

            console.log("-- calculated LP token prices: ", lpTokenPrices);
        }
    } else {
        // underlying asset is not a Curve LP token, assuming underlying asset is an erc20 token
        console.log("-- Underlying asset is a regular erc20 token.");
        let priceData = await getAssetPrice({ type: "erc20", contract: fund.data.underlyingAssetContract });
        theAssetPrices.usd = priceData.usd;
        theAssetPrices.eur = priceData.eur;
        console.log("-- Calculated " + fund.data.underlyingAsset + " prices", priceData);
    }

    // set statistics: all time, 1y, 3m, 1m, 1w
    console.log("-- calculate some statistics...");

    let activationDate = new Date(fund.data.activationBlock.date);
    activationDate.setDate(activationDate.getDate() + 2);

    // all time
    let historyItem = await getHistoryItem(fund.data.contract, dateFormat(today));
    sharePriceToday = historyItem.value;

    let valueToday = Number(historyItem.value);
    //console.log("activationDate ", dateFormat(activationDate));
    historyItem = await getHistoryItem(fund.data.contract, dateFormat(activationDate));
    //console.log("valueToday", valueToday);
    //console.log("historyItem", historyItem);
    //console.log("date", dateFormat(activationDate));
    let difference = valueToday - Number(historyItem.value);
    //console.log("difference", difference);
    let percAll = (difference / Number(historyItem.value)) * 100;

    console.log("-- all time: " + round2Dec(percAll) + "%");

    // 1 year
    let perc1Year;
    const activationDatePlus1Year = new Date(activationDate.getTime());
    activationDatePlus1Year.setFullYear(activationDatePlus1Year.getFullYear() + 1);

    if (activationDatePlus1Year < today) {
        // older then 1 year, calculate
        let date1YearAgo = new Date();
        date1YearAgo.setFullYear(date1YearAgo.getFullYear() - 1);
        historyItem = await getHistoryItem(fund.data.contract, dateFormat(date1YearAgo));
        difference = valueToday - Number(historyItem.value);
        perc1Year = (difference / Number(historyItem.value)) * 100;
    } else {
        // not older then 1 year, use all time
        perc1Year = percAll;
    }

    console.log("-- 1 year: " + round2Dec(perc1Year) + "%");

    // 3 months
    let perc3Months;
    const activationDatePlus3Months = new Date(activationDate.getTime());
    activationDatePlus3Months.setMonth(activationDatePlus3Months.getMonth() + 3);

    if (activationDatePlus3Months < today) {
        // older than 3 months, calculate
        let date3MonthsAgo = new Date();
        date3MonthsAgo.setMonth(date3MonthsAgo.getMonth() - 3);
        historyItem = await getHistoryItem(fund.data.contract, dateFormat(date3MonthsAgo));
        difference = valueToday - Number(historyItem.value);
        perc3Months = (difference / Number(historyItem.value)) * 100;
    } else {
        // not older than 3 months, use all time
        perc3Months = percAll;
    }

    console.log("-- 3 months: " + round2Dec(perc3Months) + "%");

    // 1 month
    let perc1Month;
    const activationDatePlus1Months = new Date(activationDate.getTime());
    activationDatePlus1Months.setMonth(activationDatePlus1Months.getMonth() + 1);

    if (activationDatePlus1Months < today) {
        // older than 1 month, calculate
        let date1MonthAgo = new Date();
        date1MonthAgo.setMonth(date1MonthAgo.getMonth() - 1);
        historyItem = await getHistoryItem(fund.data.contract, dateFormat(date1MonthAgo));
        difference = valueToday - Number(historyItem.value);
        perc1Month = (difference / Number(historyItem.value)) * 100;
    } else {
        // not older than 1 month, use all time
        perc1Month = percAll;
    }

    console.log("-- 1 month: " + round2Dec(perc1Month) + "%");

    // 1 week
    let perc1Week;
    const activationDatePlus1Week = new Date(activationDate.getTime());
    activationDatePlus1Week.setDate(activationDatePlus1Week.getDate() + 7);

    if (activationDatePlus1Week < today) {
        // older than 1 week, calculate
        let date1WeekAgo = new Date();
        date1WeekAgo.setDate(date1WeekAgo.getDate() - 7);
        historyItem = await getHistoryItem(fund.data.contract, dateFormat(date1WeekAgo));
        difference = valueToday - Number(historyItem.value);
        perc1Week = (difference / Number(historyItem.value)) * 100;
    } else {
        // not older than 1 week, use all time
        perc1Week = percAll;
    }

    console.log("-- 1 week: " + round2Dec(perc1Week) + "%");

    // year to date
    let perc1Ytd;
    // if fund launched this year, use all time
    if (today.getFullYear() === activationDate.getFullYear()) {
        // launched this year, use all time
        perc1Ytd = percAll;
    } else {
        // launched before this year, calculate from Jan 1st this year
        let date1Jan = new Date();
        date1Jan.setFullYear(today.getFullYear());
        date1Jan.setMonth(0);
        date1Jan.setDate(1);
        historyItem = await getHistoryItem(fund.data.contract, dateFormat(date1Jan));
        difference = valueToday - Number(historyItem.value);
        perc1Ytd = (difference / Number(historyItem.value)) * 100;
    }

    console.log("-- year-to-date: " + round2Dec(perc1Ytd) + "%");

    // gathering some more details for the fund:
    // - total assets
    // - available shares
    // - token symbol
    // - token contract
    const totalAssets = await instance.methods.totalAssets().call();
    const availableShares = await instance.methods.maxAvailableShares().call();
    const tokenSymbol = await instance.methods.symbol().call();
    //const tokenContract = await instance.methods.token().call();

    let upData = {
        sharePrice: sharePriceToday,
        totalAssets: round2Dec(Number(totalAssets) / nrDecimals),
        availableShares: round2Dec(Number(availableShares) / nrDecimals),
        tokenSymbol: tokenSymbol,
        stats: {
            _all: round2Dec(percAll),
            _1year: round2Dec(perc1Year),
            _3months: round2Dec(perc3Months),
            _1month: round2Dec(perc1Month),
            _1week: round2Dec(perc1Week),
            _ytd: round2Dec(perc1Ytd),
        },
    };

    let value = fund.data.value;
    value = theAssetPrices;
    upData.value = value;

    try {
        let returnObjFaunaUpdateFund = client.query(
            q.Update(fund.ref, {
                data: upData,
            })
        );
    } catch (error) {
        console.log(error);
    }

    console.log("-- Done with " + fund.data.name + " (" + fund.data.contract + ")");
    console.log("------------");
};

module.exports.getAllWallets = async () => {
    let returnObjFaunaGetWallets;
    try {
        returnObjFaunaGetWallets = await client.query(
            q.Map(
                q.Paginate(q.Match(q.Index("all_wallets")), { size: 100000 }),
                q.Lambda(
                    "x",
                    q.Let(
                        {
                            wallet: q.Get(q.Var("x")),
                        },
                        {
                            wallet: q.Select(["data", "wallet"], q.Var("wallet")),
                            funds: q.Map(
                                q.Select(["data", "funds"], q.Var("wallet")),
                                q.Lambda(
                                    "fund",
                                    q.Let(
                                        {
                                            fundDoc: q.Get(
                                                q.Match(q.Index("fund_by_contract"), q.Select("fund", q.Var("fund")))
                                            ),
                                        },
                                        {
                                            name: q.Select(["data", "name"], q.Var("fundDoc")),
                                            contract: q.Select(["data", "contract"], q.Var("fundDoc")),
                                            abi: q.Select(["data", "ABI"], q.Var("fundDoc")),
                                            activationBlock: q.Select(["data", "activationBlock"], q.Var("fundDoc")),
                                        }
                                    )
                                )
                            ),
                        }
                    )
                )
            )
        );
    } catch (error) {
        console.log("Can not load wallets ", error);
        return false;
    }

    return returnObjFaunaGetWallets;
};

module.exports.getWalletPlusFunds = async (wallet, next) => {
    let returnObjFaunaGetWallet;
    try {
        returnObjFaunaGetWallet = await client.query(
            q.Let(
                {
                    wallet: q.Get(q.Match(q.Index("wallet"), wallet)),
                },
                {
                    wallet: q.Select(["data", "wallet"], q.Var("wallet")),
                    funds: q.Map(
                        q.Select(["data", "funds"], q.Var("wallet")),
                        q.Lambda(
                            "addr",
                            q.Let(
                                {
                                    fundDoc: q.Get(q.Match(q.Index("fund_by_contract"), q.Var("addr"))),
                                },
                                {
                                    name: q.Select(["data", "name"], q.Var("fundDoc")),
                                    contract: q.Select(["data", "contract"], q.Var("fundDoc")),
                                    abi: q.Select(["data", "ABI"], q.Var("fundDoc")),
                                    activationBlock: q.Select(["data", "activationBlock"], q.Var("fundDoc")),
                                }
                            )
                        )
                    ),
                }
            )
        );
    } catch (err) {
        next(ApiError.internal("Can not load wallet ", err));
        return false;
    }

    return returnObjFaunaGetWallet;
};

const moveDecPoint = (places) => {
    let str = "1";
    for (let x = 0; x < places; x++) {
        str += "0";
    }
    return Number(str);
};

const saveTransaction = async (wallet, fund, type, shares, amount, blockNumber, timestamp, hash, next) => {
    let saveTransaction;
    try {
        saveTransaction = client.query(
            q.If(
                q.Exists(q.Match(q.Index("transaction_by_hash"), hash)),
                "",
                q.Create(q.Collection("transactions"), {
                    data: {
                        wallet: wallet,
                        fund: fund.toLowerCase(),
                        type: type,
                        shares: round2Dec(Number(shares)),
                        amount: round2Dec(Number(amount)),
                        blockNumber: blockNumber,
                        date: dateFormat(new Date(timestamp * 1000)),
                        hash: hash,
                    },
                })
            )
        );
    } catch (error) {
        next(ApiError.internal("Could not save transaction ", error));
        return false;
    }
};

module.exports.processTransactionsForWalletPlusFund = async (wallet, fund, migrationContract) => {
    console.log("-- Processing " + fund.name + ", IN transactions.");
    abiDecoder.addABI(fund.abi || fund.ABI);
    let hasTransactions = false;

    const instance = new web3.eth.Contract(fund.abi || fund.ABI, fund.contract);
    const decimals = await instance.methods.decimals().call();
    const nrDecimals = moveDecPoint(decimals);

    // Look for and process standard IN transactions
    console.log("-- Looking for standard IN transactions");

    let getTransfersWalletToFund = {
        data: {},
    };
    while (getTransfersWalletToFund.data.result === undefined) {
        console.log("-- Attempting to get IN transfers from " + wallet + " to " + fund.contract);
        getTransfersWalletToFund = await axios({
            method: "post",
            url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
            headers: {
                "Content-Type": "application/json",
            },
            data: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "alchemy_getAssetTransfers",
                params: [
                    {
                        fromBlock: "0x" + fund.activationBlock.block.toString(16),
                        fromAddress: wallet,
                        toAddress: fund.contract.toLowerCase(),
                    },
                ],
            }),
        });
    }

    console.log("-- Succeeded in loading standard IN transactions");

    let transfers = getTransfersWalletToFund.data.result.transfers;

    if (transfers.length > 0) {
        console.log("-- Found regular IN transactions");
        hasTransactions = true;
        // next block deals with regular transfers
        console.log("-- Processing regular transactions.");

        for (let trans of transfers) {
            let getTransactionReceipt = await axios({
                method: "post",
                url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
                headers: {
                    "Content-Type": "application/json",
                },
                data: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 0,
                    method: "eth_getTransactionReceipt",
                    params: [trans.hash],
                }),
            });

            let decodedLogs = abiDecoder.decodeLogs(getTransactionReceipt.data.result.logs);

            for (let event of decodedLogs) {
                if (event.name === "Transfer") {
                    // only process Transfer type events
                    // find the "receiver" object
                    if (event.events.find((x) => x.name === "receiver").value === wallet) {
                        // we now have the object related to the Vault token transfer to the investing wallet

                        // figure out the date that goes with the block number for the current transaction
                        let block = await web3.eth.getBlock(
                            parseInt(getTransactionReceipt.data.result.blockNumber, 16)
                        );

                        saveTransaction(
                            wallet,
                            fund.contract,
                            "in",
                            Number(event.events.find((y) => y.name === "value").value) / nrDecimals,
                            trans.value,
                            getTransactionReceipt.data.result.blockNumber,
                            block.timestamp,
                            getTransactionReceipt.data.result.transactionHash
                        );
                    }
                }
            }
        }
    }

    // Look for and process migration IN transactions
    console.log("-- Looking for migration IN transactions");

    getTransfersWalletToFund = {
        data: {},
    };
    while (getTransfersWalletToFund.data.result === undefined) {
        console.log(
            "-- Attempting to get transfers from " +
                wallet +
                " to " +
                migrationContract +
                ", from block 0x" +
                fund.activationBlock.block.toString(16)
        );
        getTransfersWalletToFund = await axios({
            method: "post",
            url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
            headers: {
                "Content-Type": "application/json",
            },
            data: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "alchemy_getAssetTransfers",
                params: [
                    {
                        fromBlock: "0x" + fund.activationBlock.block.toString(16),
                        fromAddress: wallet,
                        toAddress: migrationContract,
                    },
                ],
            }),
        });
    }

    console.log("-- Succeeded in loading migration IN transactions");

    transfers = getTransfersWalletToFund.data.result.transfers;

    if (transfers.length > 0) {
        console.log("-- Found migration IN transactions");
        // next block deals with regular transfers
        console.log("-- Processing migration transactions.");

        for (let trans of transfers) {
            let getTransactionReceipt = await axios({
                method: "post",
                url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
                headers: {
                    "Content-Type": "application/json",
                },
                data: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 0,
                    method: "eth_getTransactionReceipt",
                    params: [trans.hash],
                }),
            });

            let decodedLogs = abiDecoder.decodeLogs(getTransactionReceipt.data.result.logs);

            // we need to start by determining if this transaction is relevant
            // we do this by locating a log item that transfers funds from the migrationContract
            // to the fund contract. If this log exists, it's relevant
            let results0 = decodedLogs.filter((event) => {
                return (
                    event.name === "Transfer" &&
                    event.events[0].name === "sender" &&
                    event.events[0].value === migrationContract &&
                    event.events[1].name === "receiver" &&
                    event.events[1].value === fund.contract
                );
            });

            if (results0.length === 0) {
                break;
            }

            // we're still here, so we have relevant transfers
            console.log("-- Found migration transactions");
            hasTransactions = true;

            // get the AMOUNT part (tokens transferred from wallet to migration contract)
            let results = decodedLogs.filter((event) => {
                return (
                    event.name === "Transfer" &&
                    event.events[0].name === "sender" &&
                    event.events[0].value === wallet &&
                    event.events[1].name === "receiver" &&
                    event.events[1].value === migrationContract
                );
            });

            let amount = round2Dec(Number(results[0].events[2].value) / nrDecimals);

            // get the number of shares transferred to wallet from migrationContract
            let results2 = decodedLogs.filter((event) => {
                return (
                    event.name === "Transfer" &&
                    event.events[0].name === "sender" &&
                    event.events[0].value === "0x0000000000000000000000000000000000000000" &&
                    event.events[1].name === "receiver" &&
                    event.events[1].value === wallet
                );
            });

            let shares = round2Dec(Number(results2[0].events[2].value) / nrDecimals);

            // figure out the date that goes with the block number for the current transaction
            let block = await web3.eth.getBlock(parseInt(trans.blockNum, 16));

            saveTransaction(
                wallet,
                fund.contract,
                "in",
                shares,
                amount,
                trans.blockNum,
                block.timestamp,
                getTransactionReceipt.data.result.transactionHash
            );
        }
    }

    // Look for and process ERC20 transfer IN transactions
    console.log("-- Looking for ERC20 transfer IN transactions");

    getTransfersWalletToFund = {
        data: {},
    };
    while (getTransfersWalletToFund.data.result === undefined) {
        console.log("-- Attempting to get IN transfers from " + wallet + " to " + fund.contract);
        getTransfersWalletToFund = await axios({
            method: "post",
            url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
            headers: {
                "Content-Type": "application/json",
            },
            data: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "alchemy_getAssetTransfers",
                params: [
                    {
                        fromBlock: "0x" + fund.activationBlock.block.toString(16),
                        toAddress: wallet,
                        contractAddresses: [fund.contract.toLowerCase()],
                        category: ["erc20"],
                    },
                ],
            }),
        });
    }

    console.log("-- Succeeded in loading ERC20 transfer IN transactions");

    transfers = getTransfersWalletToFund.data.result.transfers;

    if (transfers.length > 0) {
        console.log("-- Found ERC20 transfer IN transactions");
        hasTransactions = true;
        // next block deals with regular transfers
        console.log("-- Processing ERC20 transfer transactions.");

        for (let trans of transfers) {
            let getTransactionReceipt = await axios({
                method: "post",
                url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
                headers: {
                    "Content-Type": "application/json",
                },
                data: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 0,
                    method: "eth_getTransactionReceipt",
                    params: [trans.hash],
                }),
            });

            let decodedLogs = abiDecoder.decodeLogs(getTransactionReceipt.data.result.logs);

            for (let event of decodedLogs) {
                if (event.name === "Transfer") {
                    // only process Transfer type events
                    // find the "receiver" object
                    if (event.events.find((x) => x.name === "receiver").value === wallet) {
                        // we now have the object related to the Vault token transfer to the investing wallet

                        // figure out the date that goes with the block number for the current transaction
                        let block = await web3.eth.getBlock(
                            parseInt(getTransactionReceipt.data.result.blockNumber, 16)
                        );

                        let historyItem = await getHistoryItem(
                            fund.contract.toLowerCase(),
                            dateFormat(new Date(block.timestamp * 1000))
                        );

                        let amount =
                            (historyItem.value * Number(event.events.find((y) => y.name === "value").value)) /
                            nrDecimals;

                        saveTransaction(
                            wallet,
                            fund.contract,
                            "in",
                            Number(event.events.find((y) => y.name === "value").value) / nrDecimals,
                            amount,
                            getTransactionReceipt.data.result.blockNumber,
                            block.timestamp,
                            getTransactionReceipt.data.result.transactionHash
                        );
                    }
                }
            }
        }
    }

    console.log("-- Processing " + fund.name + ", OUT transactions.");

    let getTransfersFundToWalletOUT = {
        data: {},
    };
    while (getTransfersFundToWalletOUT.data.result === undefined) {
        console.log("-- Attempting to get OUT transfers from " + wallet + " to " + fund.contract);
        getTransfersFundToWalletOUT = await axios({
            method: "post",
            url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
            headers: {
                "Content-Type": "application/json",
            },
            data: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "alchemy_getAssetTransfers",
                params: [
                    {
                        fromBlock: "0x" + fund.activationBlock.block.toString(16),
                        toAddress: wallet,
                        fromAddress: fund.contract.toLowerCase(),
                    },
                ],
            }),
        });
    }

    transfers = getTransfersFundToWalletOUT.data.result.transfers;

    if (transfers.length > 0) {
        console.log("-- Found regular OUT transactions");
        // next block deals with regular transfers
        console.log("-- Processing regular transactions.");

        for (let trans of transfers) {
            let getTransactionReceipt = await axios({
                method: "post",
                url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_KEY,
                headers: {
                    "Content-Type": "application/json",
                },
                data: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 0,
                    method: "eth_getTransactionReceipt",
                    params: [trans.hash],
                }),
            });

            let decodedLogs = abiDecoder.decodeLogs(getTransactionReceipt.data.result.logs);

            for (let event of decodedLogs) {
                if (event.name === "Transfer") {
                    // only process Transfer type events
                    // find the "receiver" object (should be the fund, since shares are being sold)
                    if (event.events.find((x) => x.name === "sender").value === wallet) {
                        // figure out the date that goes with the block number for the current transaction
                        let block = await web3.eth.getBlock(
                            parseInt(getTransactionReceipt.data.result.blockNumber, 16)
                        );

                        saveTransaction(
                            wallet,
                            fund.contract,
                            "out",
                            Number(event.events.find((y) => y.name === "value").value) / nrDecimals,
                            trans.value,
                            getTransactionReceipt.data.result.blockNumber,
                            block.timestamp,
                            getTransactionReceipt.data.result.transactionHash
                        );
                    }
                }
            }
        }
    }

    console.log("-- Done processing transactions");

    try {
        let returnObj = await client.query(
            q.Map(q.Paginate(q.Match(q.Index("wallet"), wallet)), q.Lambda("x", q.Get(q.Var("x"))))
        );

        let funds = returnObj.data[0].data.funds;

        const updatedFunds = funds.map((obj) => {
            if (obj.fund === fund.contract) {
                return { ...obj, trans: hasTransactions };
            }

            return obj;
        });

        try {
            await client.query(
                q.Update(returnObj.data[0].ref, {
                    data: {
                        funds: updatedFunds,
                    },
                })
            );
        } catch (err) {
            console.log("Could not update wallet");
        }
    } catch (err) {
        console.log("Could not retrieve wallet data");
    }

    return hasTransactions;
};

module.exports.addWallet = async (wallet, contract = false, next) => {
    let funds = [];
    if (contract) funds.push({ fund: contract, trans: true });
    try {
        let returnObjWallet = await client.query(
            q.If(
                q.Exists(q.Match(q.Index("wallet"), wallet)),
                "",
                q.Create(q.Collection("wallets"), {
                    data: {
                        wallet: wallet,
                        funds: funds,
                    },
                })
            )
        );
        return returnObjWallet;
    } catch (err) {
        next(ApiError.internal("Couldn't upsert wallet", err));
        return false;
    }
};

module.exports.getWallet = async (wallet, next) => {
    try {
        let returnObj = await client.query(
            q.Map(q.Paginate(q.Match(q.Index("wallet"), wallet)), q.Lambda("x", q.Get(q.Var("x"))))
        );
        return returnObj;
    } catch (err) {
        next(ApiError.internal("Could not load wallet " + wallet, err));
        return false;
    }
};

module.exports.addFundToWallet = async (wallet, fund, next) => {
    try {
        let returnObj = await client.query(
            q.Let(
                {
                    walletDoc: q.Get(q.Match(q.Index("wallet"), wallet)),
                    fundArray: q.Select(["data", "funds"], q.Var("walletDoc")),
                },
                q.Update(q.Select("ref", q.Var("walletDoc")), {
                    data: {
                        funds: q.Append([{ fund: fund, trans: true }], q.Var("fundArray")),
                    },
                })
            )
        );
        return returnObj;
    } catch (err) {
        next(ApiError.internal("Could not add fund " + fund + " to wallet " + wallet, err));
        return false;
    }
};

const getFund = async (contract, next) => {
    let returnObjFaunaGetFunds;
    try {
        returnObjFaunaGetFunds = await client.query(
            q.Map(q.Paginate(q.Match(q.Index("fund_by_contract"), contract)), q.Lambda("x", q.Get(q.Var("x"))))
        );
    } catch (error) {
        next(ApiError.internal("Could not load fund " + contract, error));
        return false;
    }
    return returnObjFaunaGetFunds;
};

module.exports.getFund = getFund;
