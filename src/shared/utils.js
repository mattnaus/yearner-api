const fauna = require("faunadb");
const dotenv = require("dotenv");
const axios = require("axios");
const EthDater = require("ethereum-block-by-date");
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const web3 = createAlchemyWeb3(
    "https://eth-mainnet.alchemyapi.io/v2/***REMOVED***"
);

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
                q.Paginate(
                    q.Match(q.Index("history_by_fund_date"), [contract, date])
                ),
                q.Lambda("x", q.Get(q.Var("x")))
            )
        );
    } catch (err) {
        console.log(err);
    }

    if (returnObjFaunaGetToday.data.length !== 0)
        return returnObjFaunaGetToday.data[0].data;
    else return false;
};

module.exports.updateContract = async (fund) => {
    if (typeof fund === "string") {
        // only for contract string, fetch fund from db
        let returnObjFaunaGetFunds;
        try {
            returnObjFaunaGetFunds = await client.query(
                q.Map(
                    q.Paginate(q.Match(q.Index("fund_by_contract"), fund)),
                    q.Lambda("x", q.Get(q.Var("x")))
                )
            );
        } catch (error) {
            console.log(error);
        }
        if (returnObjFaunaGetFunds.data.length !== 0) {
            fund = returnObjFaunaGetFunds.data[0];
        } else {
            return false;
        }
    }

    console.log(
        "-- Processing contract " +
            fund.data.name +
            " (" +
            fund.data.contract +
            ")"
    );

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
                apikey: "***REMOVED***",
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

    const perShare = await instance.methods
        .pricePerShare()
        .call(undefined, block.block);

    let today = new Date();
    let d = new Date(block.timestamp * 1000);
    if (fund.data.hasOwnProperty("lastUpdate")) {
        let dateSplit = fund.data.lastUpdate.split("-");

        d = new Date(
            Date.UTC(
                Number(dateSplit[0]),
                Number(dateSplit[1] - 1),
                Number(dateSplit[2]) + 1
            )
        );
        console.log("-- picking up at date: " + d, dateSplit);
    }
    let dates = [];

    // loop from d until today
    let sharePriceToday = 1;
    for (d; d <= today; d.setDate(d.getDate() + 1)) {
        let block = await dater.getDate(d, true);
        let perShare = await instance.methods
            .pricePerShare()
            .call(undefined, block.block);

        let dString = dateFormat(d);

        let perShareEth = web3.utils.fromWei(perShare, "ether");
        console.log("-- " + dString, block.block, perShareEth);

        // add entry to database
        let returnObjFaunaAddHistory;
        try {
            returnObjFaunaAddHistory = await client.query(
                q.Call(q.Function("UpdateHistory"), [
                    fund.ref.id,
                    fund.data.name,
                    fund.data.contract,
                    dString,
                    perShareEth,
                ])
            );
        } catch (error) {
            console.log(error);
        }
    }

    // set statistics: all time, 1y, 3m, 1m, 1w
    console.log("-- calculate some statistics...");

    const activationDate = new Date(fund.data.activationBlock.date);

    // all time
    let historyItem = await getHistoryItem(
        fund.data.contract,
        dateFormat(today)
    );

    sharePriceToday = historyItem.value;

    let valueToday = Number(historyItem.value);
    historyItem = await getHistoryItem(
        fund.data.contract,
        dateFormat(activationDate)
    );
    let difference = valueToday - Number(historyItem.value);
    let percAll = (difference / Number(historyItem.value)) * 100;

    console.log("-- all time: " + round2Dec(percAll) + "%");

    // 1 year
    let perc1Year;
    const activationDatePlus1Year = new Date(activationDate.getTime());
    activationDatePlus1Year.setFullYear(
        activationDatePlus1Year.getFullYear() + 1
    );

    if (activationDatePlus1Year < today) {
        // older then 1 year, calculate
        let date1YearAgo = new Date();
        date1YearAgo.setFullYear(date1YearAgo.getFullYear() - 1);
        historyItem = await getHistoryItem(
            fund.data.contract,
            dateFormat(date1YearAgo)
        );
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
    activationDatePlus3Months.setMonth(
        activationDatePlus3Months.getMonth() + 3
    );

    if (activationDatePlus3Months < today) {
        // older than 3 months, calculate
        let date3MonthsAgo = new Date();
        date3MonthsAgo.setMonth(date3MonthsAgo.getMonth() - 3);
        historyItem = await getHistoryItem(
            fund.data.contract,
            dateFormat(date3MonthsAgo)
        );
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
    activationDatePlus1Months.setMonth(
        activationDatePlus1Months.getMonth() + 1
    );

    if (activationDatePlus1Months < today) {
        // older than 1 month, calculate
        let date1MonthAgo = new Date();
        date1MonthAgo.setMonth(date1MonthAgo.getMonth() - 1);
        historyItem = await getHistoryItem(
            fund.data.contract,
            dateFormat(date1MonthAgo)
        );
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
        historyItem = await getHistoryItem(
            fund.data.contract,
            dateFormat(date1WeekAgo)
        );
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
        historyItem = await getHistoryItem(
            fund.data.contract,
            dateFormat(date1Jan)
        );
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
    const tokenContract = await instance.methods.token().call();

    try {
        let returnObjFaunaUpdateFund = client.query(
            q.Update(fund.ref, {
                data: {
                    sharePrice: round2Dec(Number(sharePriceToday)),
                    totalAssets: web3.utils.fromWei(totalAssets, "ether"),
                    availableShares: web3.utils.fromWei(
                        availableShares,
                        "ether"
                    ),
                    tokenSymbol: tokenSymbol,
                    tokenContract: tokenContract,
                    stats: {
                        _all: round2Dec(percAll),
                        _1year: round2Dec(perc1Year),
                        _3months: round2Dec(perc3Months),
                        _1month: round2Dec(perc1Month),
                        _1week: round2Dec(perc1Week),
                        _ytd: round2Dec(perc1Ytd),
                    },
                },
            })
        );
    } catch (error) {
        console.log(error);
    }

    console.log(
        "-- Done with " + fund.data.name + " (" + fund.data.contract + ")"
    );
    console.log("------------");
};
