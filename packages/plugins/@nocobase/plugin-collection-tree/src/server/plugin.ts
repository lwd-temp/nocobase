/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { Collection, Model, SyncOptions, DestroyOptions } from '@nocobase/database';
import { DataSource, SequelizeCollectionManager } from '@nocobase/data-source-manager';
import { Transaction } from 'sequelize';
import lodash from 'lodash';
import { TreeCollection } from './tree-collection';

const getFilterTargetKey = (model: Model) => {
  // @ts-ignore
  return model.constructor.collection.filterTargetKey;
};

class PluginCollectionTreeServer extends Plugin {
  async beforeLoad() {
    const condition = (options) => {
      return options.tree;
    };

    this.app.db.collectionFactory.registerCollectionType(TreeCollection, {
      condition,
    });

    this.app.dataSourceManager.afterAddDataSource((dataSource: DataSource) => {
      const collectionManager = dataSource.collectionManager;
      if (collectionManager instanceof SequelizeCollectionManager) {
        collectionManager.db.on('afterDefineCollection', (collection: Collection) => {
          if (!condition(collection.options)) {
            return;
          }
          const name = `${dataSource.name}_${collection.name}_path`;
          const parentForeignKey = collection.treeParentField?.foreignKey || 'parentId';

          //always define tree path collection
          this.defineTreePathCollection(name);

          //afterSync
          collectionManager.db.on(`${collection.name}.afterSync`, async ({ transaction }) => {
            // trigger tree path collection create logic
            await this.db.getCollection(name).sync({ transaction } as SyncOptions);
          });

          //afterCreate
          this.db.on(`${collection.name}.afterCreate`, async (model: Model, options) => {
            const { transaction } = options;
            const tk = getFilterTargetKey(model);
            let path = `/${model.get(tk)}`;
            path = await this.getTreePath(model, path, collection, name, transaction);
            const rootPk = path.split('/')[1];
            await this.app.db.getRepository(name).create({
              values: {
                nodePk: model.get(tk),
                path: path,
                rootPk: rootPk ? Number(rootPk) : null,
              },
              transaction,
            });
          });

          //afterUpdate
          this.db.on(`${collection.name}.afterUpdate`, async (model: Model, options) => {
            const tk = getFilterTargetKey(model);
            // only update parentId and filterTargetKey
            if (!(model._changed.has(tk) || model._changed.has(parentForeignKey))) {
              return;
            }
            const { transaction } = options;
            let path = `/${model.get(tk)}`;
            path = await this.getTreePath(model, path, collection, name, transaction);
            const collectionTreePath = this.db.getCollection(name);
            const nodePkColumnName = collectionTreePath.getField('nodePk').columnName();
            const pathData = await this.app.db.getRepository(name).findOne({
              filter: {
                [nodePkColumnName]: model.get(tk),
              },
              transaction,
            });

            const relatedNodes = await this.app.db.getRepository(name).find({
              filter: {
                path: {
                  $startsWith: `${pathData.get('path')}`,
                },
              },
              transaction,
            });
            const rootPk = path.split('/')[1];
            for (const node of relatedNodes) {
              await this.app.db.getRepository(name).update({
                values: {
                  path: node.get('path').replace(`${pathData.get('path')}`, path),
                  rootPk: rootPk ? Number(rootPk) : null,
                },
                filter: {
                  [nodePkColumnName]: node.get('nodePk'),
                },
                transaction,
              });
            }
          });

          //afterDestroy
          this.db.on(`${collection.name}.afterDestroy`, async (model: Model, options: DestroyOptions) => {
            const tk = getFilterTargetKey(model);
            await this.app.db.getRepository(name).destroy({
              filter: {
                nodePk: model.get(tk),
              },
              transaction: options.transaction,
            });
          });
        });
      }
    });

    this.db.on('collections.afterDestroy', async (collection: Model, { transaction }) => {
      const name = `main_${collection.get('name')}_path`;
      if (!condition(collection.options)) {
        return;
      }

      const collectionTree = this.db.getCollection(name);
      if (collectionTree) {
        await this.db.getCollection(name).removeFromDb({ transaction });
      }
    });
  }

  private async defineTreePathCollection(name: string) {
    this.db.collection({
      name,
      autoGenId: false,
      timestamps: false,
      fields: [
        { type: 'integer', name: 'nodePk' },
        { type: 'string', name: 'path', length: 1024 },
        { type: 'integer', name: 'rootPk' },
      ],
      indexes: [
        {
          fields: [{ name: 'path', length: 191 }],
        },
      ],
    });
  }

  private async getTreePath(
    model: Model,
    path: string,
    collection: Collection,
    pathCollectionName: string,
    transaction?: Transaction,
  ) {
    const tk = getFilterTargetKey(model);
    const parentForeignKey = collection.treeParentField?.foreignKey || 'parentId';
    if (model.get(parentForeignKey) && model.get(parentForeignKey) !== null) {
      const parent = await this.app.db.getRepository(collection.name).findOne({
        filter: {
          [tk]: model.get(parentForeignKey),
        },
        transaction,
      });
      if (parent && parent.get(parentForeignKey) !== model.get(tk)) {
        path = `/${parent.get(tk)}${path}`;
        if (parent.get(parentForeignKey) !== null) {
          const collectionTreePath = this.app.db.getCollection(pathCollectionName);
          const nodePkColumnName = collectionTreePath.getField('nodePk').columnName();
          const parentPathData = await this.app.db.getRepository(pathCollectionName).findOne({
            filter: {
              [nodePkColumnName]: parent.get(tk),
            },
            transaction,
          });
          const parentPath = lodash.get(parentPathData, 'path', null);
          if (parentPath == null) {
            path = await this.getTreePath(parent, path, collection, pathCollectionName, transaction);
          } else {
            path = `${parentPath}/${model.get(tk)}`;
          }
        }
      }
    }
    return path;
  }
}

export default PluginCollectionTreeServer;