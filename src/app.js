const express = require('express')
const bodyParser = require('body-parser')
const {sequelize} = require('./model')
const {Op} = require("sequelize")
const {getProfile} = require('./middleware/getProfile')
const _ = require('lodash')
const app = express()
app.use(bodyParser.json())
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * Getting a contract for a logged in user
 *
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) =>{
    const {Contract} = req.app.get('models')
    const {id} = req.params
    const contract = await Contract.findOne({
        where: {
            id,
            // Profile can be Contractor or Client
            [Op.or]: [
                {ContractorId: req.profile.id},
                {ClientId: req.profile.id}
            ]
        }
    })
    if(!contract) return res.status(404).end()
    res.json(contract)
})

/**
 * Getting all contracts of a logged in user
 *
 * @returns list of contracts belonging to a logged in user
 */
app.get('/contracts', getProfile, async (req, res) =>{
    const {Contract} = req.app.get('models')
    const contracts = await Contract.findAll({
        where: {
            // Profile can be Contractor or Client
            [Op.or]: [
                {ContractorId: req.profile.id},
                {ClientId: req.profile.id}
            ]
        }
    })
    if(!contracts.length) return res.status(404).end()
    res.json(contracts)
})

/**
 * Get all unpaid jobs for a user (either a client or contractor), for active
 * contracts only.
 *
 * @returns list of unpaid jobs
 */
app.get('/jobs/unpaid', getProfile, async (req, res) =>{
    const {Contract, Job} = req.app.get('models')
    const jobs = await Job.findAll({
        where: {
            paid: {[Op.not]: true}
        },
        include: [{
            model: Contract,
            where: {
                // Profile can be Contractor or Client
                [Op.or]: [
                    {ContractorId: req.profile.id},
                    {ClientId: req.profile.id}
                ]
            }
        }]
    })
    if(!jobs.length) return res.status(404).end()
    res.json(jobs)
})

/**
 * Pay for a job, a client can only pay if his balance >= the amount to pay.
 * The amount should be moved from the client's balance to the contractor balance.
 *
 * @returns updated job
 */
app.post('/jobs/:job_id/pay', getProfile, async (req, res) =>{
    const {Contract, Job, Profile} = req.app.get('models')
    const {job_id} = req.params
    const job = await Job.findOne({
        // Only not paid contracts can be paid
        where: {id: job_id, paid: {[Op.not]: true}},
        include: [{
            model: Contract,
            // Only logged in client can pay for the job
            where: {ClientId: req.profile.id}
        }]
    })
    // Job already paid or not found
    if (!job) return res.status(404).end()
    // Return error `402 Payment required` if balance is not enough
    if (job.price > req.profile.balance) return res.status(402).end()

    const contractor = await Profile.findOne({where: {id: job.Contract.ContractorId}})
    // Remove money from the logged in client
    await req.profile.update({balance: req.profile.balance - job.price})
    // Give money to a contractor
    await contractor.update({balance: contractor.balance + job.price})
    // Mark job done
    await job.update({
        paid: true,
        paymentDate: new Date()
    })
    res.json(job)
})

/**
 * Deposits money into the the the balance of a client, a client can't deposit
 * more than 25% his total of jobs to pay. (at the deposit moment)
 *
 * @returns amount of deposit
 */
app.post('/balances/deposit/:userId', getProfile, async (req, res) =>{
    const {Contract, Job, Profile} = req.app.get('models')
    const {userId} = req.params
    const job = await Job.findAll({
        where: {paid: {[Op.not]: true}},
        include: [{
            model: Contract,
            where: {ClientId: req.profile.id},
            attributes: []
        }],
        attributes: [[sequelize.fn('sum', sequelize.col('price')), 'totalPrice']]
    })
    // Round down, so it will be always less than 25%
    const possibleDeposit = Math.floor(job[0].toJSON().totalPrice/4)
    // Return error `402 Payment required` if balance is not enough
    if (req.profile.balance < possibleDeposit) return res.status(402).end()

    const contractor = await Profile.findOne({where: {id: userId, type: 'contractor'}})
    if (!contractor) return res.status(404).json({error: `Profile '${userId}' is not a contractor`})

    // Remove money from the logged in client
    await req.profile.update({balance: req.profile.balance - possibleDeposit})
    // Give money to a contractor
    await contractor.update({balance: contractor.balance + possibleDeposit})
    res.json({deposited: possibleDeposit})
})

/**
 * Returns the profession that earned the most money (sum of jobs paid) for any
 * contactor that worked in the query time range.
 *
 * @returns the best profession name
 */
app.get('/admin/best-profession', async (req, res) =>{
    const {Contract, Job, Profile} = req.app.get('models')
    const {start, end} = req.query
    const jobs = await Job.findAll({
        // Get all unpaid jobs belonging to the client
        where: {
            paid: true,
            paymentDate: {[Op.between]: [new Date(start), new Date(end)]}
        },
        include: [{
            model: Contract,
            include: [{model: Profile, as: 'Contractor', attributes: ['profession']}],
            attributes: []
        }],
        raw: true,
        attributes: [[sequelize.fn('sum', sequelize.col('price')), 'totalPrice']],
        group : ['Contract.Contractor.profession']
    })
    const theBestProfession = _.maxBy(jobs, 'totalPrice')['Contract.Contractor.profession']
    res.json({theBestProfession})
})

/**
 * returns the clients the paid the most for jobs in the query time period.
 * Limit query parameter should be applied, default limit is 2
 *
 * @returns list of clients paid the most
 */
app.get('/admin/best-clients', async (req, res) =>{
    const {Contract, Job, Profile} = req.app.get('models')
    const {start, end, limit = 2} = req.query
    const jobs = await Job.findAll({
        // Get all unpaid jobs belonging to the client
        where: {
            paid: true,
            // paymentDate: {[Op.between]: [new Date(start), new Date(end)]}
        },
        include: [{
            model: Contract,
            include: [{model: Profile, as: 'Client', attributes: ['id', 'firstName', 'lastName']}],
            attributes: []
        }],
        raw: true,
        attributes: [[sequelize.fn('sum', sequelize.col('price')), 'paid']],
        group : ['Contract.ClientId'],
        limit
    })
    const clients = jobs.map(j => {
        return {
            id: j['Contract.Client.id'],
            fullName: `${j['Contract.Client.firstName']} ${j['Contract.Client.lastName']}`,
            paid: j.paid
        }
    })
    res.json(clients)
})

module.exports = app;
