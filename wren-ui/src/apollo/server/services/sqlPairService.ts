import { IWrenAIAdaptor } from '../adaptors';
import { SqlPairResult, SqlPairStatus } from '../models/adaptor';
import { ISqlPairRepository, SqlPair } from '../repositories/sqlPairRepository';
import { getLogger } from '@server/utils';
import { chunk } from 'lodash';
import * as Errors from '@server/utils/error';

const logger = getLogger('SqlPairService');

export interface CreateSqlPair {
  sql: string;
  question: string;
}

export interface EditSqlPair {
  sql?: string;
  question?: string;
}

export interface ISqlPairService {
  getProjectSqlPairs(projectId: number): Promise<SqlPair[]>;
  createSqlPairs(
    projectId: number,
    sqlPairs: CreateSqlPair[],
  ): Promise<SqlPair[]>;
  editSqlPair(
    projectId: number,
    sqlPairId: number,
    sqlPair: EditSqlPair,
  ): Promise<SqlPair>;
  deleteSqlPair(projectId: number, sqlPairId: number): Promise<boolean>;
}

export class SqlPairService implements ISqlPairService {
  private sqlPairRepository: ISqlPairRepository;
  private wrenAIAdaptor: IWrenAIAdaptor;

  constructor({
    sqlPairRepository,
    wrenAIAdaptor,
  }: {
    sqlPairRepository: ISqlPairRepository;
    wrenAIAdaptor: IWrenAIAdaptor;
  }) {
    this.sqlPairRepository = sqlPairRepository;
    this.wrenAIAdaptor = wrenAIAdaptor;
  }
  public async getProjectSqlPairs(projectId: number): Promise<SqlPair[]> {
    return this.sqlPairRepository.findAllBy({ projectId });
  }

  public async createSqlPairs(
    projectId: number,
    sqlPairs: CreateSqlPair[],
  ): Promise<SqlPair[]> {
    const tx = await this.sqlPairRepository.transaction();
    const newPairs = await this.sqlPairRepository.createMany(
      sqlPairs.map((pair) => ({
        ...pair,
        projectId,
      })),
      { tx },
    );
    // batch parall process with size of 10
    const successPairs = [];
    const errorPairs = [];
    const chunks = chunk(newPairs, 10);
    for (const pairs of chunks) {
      await Promise.allSettled(
        pairs.map(async (pair) => {
          const { queryId } = await this.wrenAIAdaptor.deploySqlPair(
            projectId,
            pair,
          );
          const deployResult = await this.waitUntilSqlPairResult(queryId);
          if (deployResult.error) {
            errorPairs.push(deployResult.error);
          }
          successPairs.push(deployResult);
        }),
      ).then(async (_result) => {
        if (errorPairs.length > 0) {
          logger.debug(
            `deploy sql pair failed. ${errorPairs.map((pair) => pair.question).join(', ')}`,
          );
          await tx.rollback();
          await this.wrenAIAdaptor.deleteSqlPairs(
            projectId,
            successPairs.map((pair) => pair.id),
          );
          throw Errors.create(Errors.GeneralErrorCodes.DEPLOY_SQL_PAIR_ERROR, {
            customMessage: errorPairs.map((pair) => pair.message).join(', '),
          });
        }
      });
    }
    await tx.commit();
    return newPairs;
  }

  async editSqlPair(
    projectId: number,
    sqlPairId: number,
    sqlPair: EditSqlPair,
  ): Promise<SqlPair> {
    // First verify the SQL pair exists and belongs to the project
    const existingPair = await this.sqlPairRepository.findOneBy({
      id: sqlPairId,
      projectId,
    });
    if (!existingPair) {
      throw new Error(
        `SQL pair with ID ${sqlPairId} not found in project ${projectId}`,
      );
    }

    // Update only the provided fields
    const updatedData: Partial<SqlPair> = {
      sql: existingPair.sql,
      question: existingPair.question,
    };

    if (sqlPair.sql !== undefined) {
      updatedData.sql = sqlPair.sql;
    }

    if (sqlPair.question !== undefined) {
      updatedData.question = sqlPair.question;
    }
    const tx = await this.sqlPairRepository.transaction();
    try {
      const updatedSqlPair = await this.sqlPairRepository.updateOne(
        sqlPairId,
        updatedData,
        { tx },
      );
      const { queryId } = await this.wrenAIAdaptor.deploySqlPair(
        projectId,
        updatedSqlPair,
      );
      const deployResult = await this.waitUntilSqlPairResult(queryId);
      if (deployResult.error) {
        throw Errors.create(Errors.GeneralErrorCodes.DEPLOY_SQL_PAIR_ERROR, {
          customMessage: deployResult.error.message,
        });
      }
      await tx.commit();
      return updatedSqlPair;
    } catch (error) {
      logger.error(`edit sql pair failed. ${error}`);
      await tx.rollback();
      throw Errors.create(Errors.GeneralErrorCodes.DEPLOY_SQL_PAIR_ERROR, {
        customMessage: error.message,
      });
    }
  }

  async deleteSqlPair(projectId: number, sqlPairId: number): Promise<boolean> {
    // First verify the SQL pair exists and belongs to the project
    const existingPair = await this.sqlPairRepository.findOneBy({
      id: sqlPairId,
      projectId,
    });

    if (!existingPair) {
      throw new Error(
        `SQL pair with ID ${sqlPairId} not found in project ${projectId}`,
      );
    }
    const tx = await this.sqlPairRepository.transaction();
    try {
      await this.sqlPairRepository.deleteOne(sqlPairId, { tx });
      await this.wrenAIAdaptor.deleteSqlPairs(projectId, [sqlPairId]);
      await tx.commit();
      return true;
    } catch (error) {
      logger.error(`delete sql pair failed. ${error}`);
      await tx.rollback();
      throw Errors.create(Errors.GeneralErrorCodes.DEPLOY_SQL_PAIR_ERROR, {
        customMessage: error.message,
      });
    }
  }

  private async waitUntilSqlPairResult(
    queryId: string,
  ): Promise<SqlPairResult> {
    let result = await this.wrenAIAdaptor.getSqlPairResult(queryId);
    while (!this.isFinishedState(result.status)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await this.wrenAIAdaptor.getSqlPairResult(queryId);
    }
    return result;
  }

  private isFinishedState(status: SqlPairStatus) {
    return [SqlPairStatus.FINISHED, SqlPairStatus.FAILED].includes(status);
  }
}
