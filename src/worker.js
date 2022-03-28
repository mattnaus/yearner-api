const cron = require("node-cron");
const fauna = require("faunadb");
const dotenv = require("dotenv");
const shared = require("./shared/utils.js");
dotenv.config();

const q = fauna.query;
const client = new fauna.Client({
    secret: process.env.FAUNA_SECRET,
});

cron.schedule(
    "30 9 * * *",
    () => {
        update();
    },
    {
        scheduled: true,
        timezone: "Asia/Bangkok",
    }
);

cron.schedule(
    "15 11 * * *",
    () => {
        updateTransactions();
    },
    {
        scheduled: true,
        timezone: "Asia/Bangkok",
    }
);

const update = async () => {
    // grab all funds
    let returnObjFaunaGetFunds;
    try {
        returnObjFaunaGetFunds = await client.query(
            q.Map(q.Paginate(q.Match(q.Index("all_funds")), { size: 100 }), q.Lambda("x", q.Get(q.Var("x"))))
        );
    } catch (error) {
        console.log(error);
    }

    if (returnObjFaunaGetFunds.data.length !== 0) {
        for (let fund of returnObjFaunaGetFunds.data) {
            await shared.updateContract(fund);
        }
    }
};

const updateTransactions = async () => {
    const wallets = await shared.getAllWallets();
    const migrationContract = "***REMOVED***";

    if (wallets.data.length === 0) return;

    for (let wallet of wallets.data) {
        for (let fund of wallet.funds) {
            await shared.processTransactionsForWalletPlusFund(wallet.wallet, fund, migrationContract);
        }
    }
};
